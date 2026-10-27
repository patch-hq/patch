package io.github.tomchambers2.patch

import android.content.Intent
import android.media.AudioFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.IOException
import java.io.OutputStream

/**
 * The phone's own speech recogniser for composer dictation
 * (`NativeModules.PatchSpeech`, spec/07 § Dictation engines).
 *
 * It never opens the microphone. Patch's own AudioRecord tap
 * ([PatchVoiceMicModule]) keeps capturing, so the audio is still there for
 * Whisper's tidy-up, and every frame it reads is also written into a pipe the
 * recogniser reads from (`EXTRA_AUDIO_SOURCE`, Android 13+). Two captures of
 * one microphone would leave one of them hearing silence on many phones.
 *
 * A segmented session (`EXTRA_SEGMENTED_SESSION`) keeps recognising across
 * pauses until the pipe is closed, reporting the words in progress
 * (`partial`) and each finished stretch (`segment`). Closing the pipe ends the
 * session and `end` follows.
 *
 * NO FALLBACK: an older Android, a phone with no recognition service or a
 * recogniser error rejects or emits `error`; nothing is quietly sent elsewhere.
 */
class PatchSpeechModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  companion object {
    const val EVENT = "PatchSpeechEvent"
    const val TAG = "patch-voice"
  }

  private val main = Handler(Looper.getMainLooper())
  private var recognizer: SpeechRecognizer? = null
  @Volatile private var sink: OutputStream? = null
  private var readEnd: ParcelFileDescriptor? = null

  override fun getName(): String = "PatchSpeech"

  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}

  @ReactMethod
  fun start(language: String, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      promise.reject(
        "unsupported",
        "The phone's own recogniser needs Android 13 or newer (this phone runs ${Build.VERSION.RELEASE}).",
      )
      return
    }
    main.post {
      try {
        if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
          promise.reject("unavailable", "This phone has no speech recognition service.")
          return@post
        }
        teardown()
        val pipe = ParcelFileDescriptor.createPipe()
        readEnd = pipe[0]
        sink = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])
        val rec = SpeechRecognizer.createSpeechRecognizer(ctx)
        rec.setRecognitionListener(listener)
        recognizer = rec
        val intent =
          Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
              RecognizerIntent.EXTRA_LANGUAGE_MODEL,
              RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
            )
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0])
            putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
            putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
            putExtra(
              RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE,
              PatchVoiceMicModule.SAMPLE_RATE,
            )
            putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
          }
        PatchVoiceMicModule.tap = { frame -> write(frame) }
        rec.startListening(intent)
        Log.i(TAG, "phone recogniser: started ($language)")
        promise.resolve(null)
      } catch (e: Throwable) {
        teardown()
        promise.reject("start_failed", e.message, e)
      }
    }
  }

  private fun write(frame: ByteArray) {
    val out = sink ?: return
    try {
      out.write(frame)
    } catch (e: IOException) {
      // The recogniser has stopped reading: it reports why through onError.
      sink = null
    }
  }

  /** End the session: close the pipe, and `end` follows once the last words are in. */
  @ReactMethod
  fun stop(promise: Promise) {
    PatchVoiceMicModule.tap = null
    val out = sink
    sink = null
    try {
      out?.close()
    } catch (_: IOException) {
      // already closed by the reader side
    }
    promise.resolve(null)
  }

  /** Drop the session with no further results. */
  @ReactMethod
  fun cancel(promise: Promise) {
    main.post {
      teardown()
      promise.resolve(null)
    }
  }

  private fun teardown() {
    PatchVoiceMicModule.tap = null
    try {
      sink?.close()
    } catch (_: IOException) {}
    sink = null
    try {
      readEnd?.close()
    } catch (_: IOException) {}
    readEnd = null
    recognizer?.let {
      try {
        it.cancel()
      } catch (_: Throwable) {}
      it.destroy()
    }
    recognizer = null
  }

  private fun first(results: Bundle?): String =
    results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""

  private fun emit(type: String, text: String? = null) {
    val map = Arguments.createMap()
    map.putString("type", type)
    if (text != null) map.putString(if (type == "error") "message" else "text", text)
    try {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(EVENT, map)
    } catch (_: Throwable) {
      // React instance gone — nothing to deliver to.
    }
  }

  private val listener =
    object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) {}
      override fun onBeginningOfSpeech() {}
      override fun onRmsChanged(rmsdB: Float) {}
      override fun onBufferReceived(buffer: ByteArray?) {}
      override fun onEndOfSpeech() {}
      override fun onEvent(eventType: Int, params: Bundle?) {}

      override fun onPartialResults(partialResults: Bundle?) {
        emit("partial", first(partialResults))
      }

      override fun onSegmentResults(segmentResults: Bundle) {
        emit("segment", first(segmentResults))
      }

      override fun onEndOfSegmentedSession() {
        emit("end")
        main.post { teardown() }
      }

      override fun onResults(results: Bundle?) {
        // A recogniser that ignores segmented mode answers once, at the end.
        emit("segment", first(results))
        emit("end")
        main.post { teardown() }
      }

      override fun onError(error: Int) {
        Log.e(TAG, "phone recogniser: error $error")
        emit("error", errorText(error))
        main.post { teardown() }
      }
    }

  private fun errorText(code: Int): String =
    when (code) {
      SpeechRecognizer.ERROR_AUDIO -> "audio error"
      SpeechRecognizer.ERROR_CLIENT -> "client error"
      SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "microphone permission missing"
      SpeechRecognizer.ERROR_NETWORK -> "network error"
      SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network timeout"
      SpeechRecognizer.ERROR_NO_MATCH -> "no speech recognised"
      SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "recogniser busy"
      SpeechRecognizer.ERROR_SERVER -> "server error"
      SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no speech heard"
      SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> "language not supported"
      SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "language not downloaded"
      SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "too many requests"
      else -> "error $code"
    }

  override fun invalidate() {
    main.post { teardown() }
    super.invalidate()
  }
}
