package dev.patchhq.app

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * The phone's own engines for a direct call (`NativeModules.PatchDirectCall`,
 * spec/07 § Direct calls), each behind the shared runtime's engine interfaces
 * in src/lib/directCall.ts:
 *
 * - speech to text: Android's on-device recogniser reads one finished
 *   utterance (fed through a pipe, so the microphone is never opened twice);
 * - text to speech: Android's installed voices, and playback of a cloud
 *   engine's 24 kHz PCM, each resolving when the piece has finished playing;
 * - end of turn: Smart Turn, the same model and features as the host, run by
 *   onnxruntime-android. The model is downloaded once from the Patch server
 *   and checked against its pinned checksum before it loads.
 *
 * NO FALLBACK: an engine that is missing or fails rejects with the reason.
 */
class PatchDirectCallModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  companion object {
    const val TAG = "patch-voice"
  }

  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()

  override fun getName(): String = "PatchDirectCall"

  // ---- what this phone has ----

  private var tts: TextToSpeech? = null
  private var ttsReady: Boolean? = null
  private val ttsWaiting = mutableListOf<(Boolean) -> Unit>()

  private fun withTts(then: (TextToSpeech?) -> Unit) {
    main.post {
      when (ttsReady) {
        true -> then(tts)
        false -> then(null)
        null -> {
          ttsWaiting.add { ok -> then(if (ok) tts else null) }
          if (tts == null) {
            tts =
              TextToSpeech(ctx) { status ->
                main.post {
                  ttsReady = status == TextToSpeech.SUCCESS
                  tts?.setOnUtteranceProgressListener(progress)
                  val waiting = ttsWaiting.toList()
                  ttsWaiting.clear()
                  waiting.forEach { it(ttsReady == true) }
                }
              }
          }
        }
      }
    }
  }

  /** The English voices installed on the phone, that need no network. */
  private fun localVoices(t: TextToSpeech): List<String> =
    (t.voices ?: emptySet())
      .filter {
        it.locale.language == "en" &&
          !it.isNetworkConnectionRequired &&
          !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)
      }
      .map { it.name }
      .sorted()

  @ReactMethod
  fun deviceEngines(promise: Promise) {
    withTts { t ->
      val out = Arguments.createMap()
      out.putBoolean(
        "stt",
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
          SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx),
      )
      val voices = Arguments.createArray()
      if (t != null) localVoices(t).forEach { voices.pushString(it) }
      out.putArray("voices", voices)
      promise.resolve(out)
    }
  }

  // ---- speech to text: one utterance ----

  @ReactMethod
  fun transcribe(pcmBase64: String, language: String, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      promise.reject("unsupported", "the on-device recogniser needs Android 13 or newer")
      return
    }
    val pcm = Base64.decode(pcmBase64, Base64.NO_WRAP)
    main.post {
      if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx)) {
        promise.reject("unavailable", "this phone has no on-device speech recogniser")
        return@post
      }
      val pipe = ParcelFileDescriptor.createPipe()
      val rec = SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx)
      var settled = false
      fun done(block: () -> Unit) {
        if (settled) return
        settled = true
        block()
        rec.destroy()
        try {
          pipe[0].close()
        } catch (_: Exception) {}
      }
      rec.setRecognitionListener(
        object : RecognitionListener {
          override fun onResults(results: Bundle?) {
            val text =
              results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
            done { promise.resolve(text ?: "") }
          }

          override fun onError(error: Int) {
            // No match: the recogniser heard no words in the utterance.
            if (error == SpeechRecognizer.ERROR_NO_MATCH) done { promise.resolve("") }
            else done { promise.reject("recogniser_error", "the recogniser failed (error $error)") }
          }

          override fun onReadyForSpeech(params: Bundle?) {}
          override fun onBeginningOfSpeech() {}
          override fun onRmsChanged(rmsdB: Float) {}
          override fun onBufferReceived(buffer: ByteArray?) {}
          override fun onEndOfSpeech() {}
          override fun onPartialResults(partialResults: Bundle?) {}
          override fun onEvent(eventType: Int, params: Bundle?) {}
        },
      )
      val intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
          putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
          putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
          putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0])
          putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
          putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
          putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, SmartTurnFeatures.SAMPLE_RATE)
        }
      rec.startListening(intent)
      worker.execute {
        try {
          ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]).use { it.write(pcm) }
        } catch (e: Exception) {
          main.post { done { promise.reject("pipe_failed", e.message, e) } }
        }
      }
    }
  }

  // ---- text to speech: Android's voices ----

  private val speaking = mutableMapOf<String, Promise>()

  private val progress =
    object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String?) {}

      override fun onDone(utteranceId: String?) {
        main.post { speaking.remove(utteranceId)?.resolve(null) }
      }

      override fun onStop(utteranceId: String?, interrupted: Boolean) {
        main.post { speaking.remove(utteranceId)?.resolve(null) }
      }

      @Deprecated("Deprecated in Java")
      override fun onError(utteranceId: String?) {
        main.post { speaking.remove(utteranceId)?.reject("tts_error", "Android could not speak it") }
      }

      override fun onError(utteranceId: String?, errorCode: Int) {
        main.post {
          speaking.remove(utteranceId)
            ?.reject("tts_error", "Android could not speak it (error $errorCode)")
        }
      }
    }

  @ReactMethod
  fun speak(text: String, voice: String, id: String, promise: Promise) {
    withTts { t ->
      if (t == null) {
        promise.reject("tts_unavailable", "this phone's text to speech did not start")
        return@withTts
      }
      val v = t.voices?.firstOrNull { it.name == voice }
      if (v == null) {
        promise.reject("no_voice", "Android has no voice \"$voice\"")
        return@withTts
      }
      t.voice = v
      speaking[id] = promise
      if (t.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) {
        speaking.remove(id)
        promise.reject("tts_error", "Android would not start speaking")
      }
    }
  }

  @ReactMethod
  fun stopSpeaking(promise: Promise) {
    main.post {
      tts?.stop()
      speaking.values.forEach { it.resolve(null) }
      speaking.clear()
      promise.resolve(null)
    }
  }

  // ---- playback of a cloud engine's speech ----

  private var track: AudioTrack? = null
  private var playing: Promise? = null

  private fun finishPlayback() {
    track?.let {
      try {
        it.stop()
      } catch (_: IllegalStateException) {}
      it.release()
    }
    track = null
    playing?.resolve(null)
    playing = null
  }

  /** Play one piece of PCM16; resolves when it has played to the end or been stopped. */
  @ReactMethod
  fun playPcm(pcmBase64: String, sampleRate: Int, promise: Promise) {
    val bytes = Base64.decode(pcmBase64, Base64.NO_WRAP)
    main.post {
      finishPlayback()
      try {
        val t =
          AudioTrack.Builder()
            .setAudioAttributes(
              AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
            )
            .setAudioFormat(
              AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(sampleRate)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build(),
            )
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(bytes.size)
            .build()
        t.write(bytes, 0, bytes.size)
        val frames = bytes.size / 2
        t.notificationMarkerPosition = frames
        t.setPlaybackPositionUpdateListener(
          object : AudioTrack.OnPlaybackPositionUpdateListener {
            override fun onMarkerReached(at: AudioTrack?) {
              if (track === at) finishPlayback()
            }

            override fun onPeriodicNotification(at: AudioTrack?) {}
          },
          main,
        )
        track = t
        playing = promise
        t.play()
      } catch (e: Exception) {
        Log.w(TAG, "direct call: playback failed: ${e.message}")
        track = null
        promise.reject("playback_failed", "the phone could not play the reply: ${e.message}", e)
      }
    }
  }

  @ReactMethod
  fun stopPcm(promise: Promise) {
    main.post {
      finishPlayback()
      promise.resolve(null)
    }
  }

  // ---- Smart Turn ----

  private var env: OrtEnvironment? = null
  private var session: OrtSession? = null

  private fun sha256(f: File): String =
    MessageDigest.getInstance("SHA-256").digest(f.readBytes()).joinToString("") {
      "%02x".format(it)
    }

  /** Download (once) and load the model the Patch server serves with the app. */
  @ReactMethod
  fun loadSmartTurn(url: String, sha256: String, promise: Promise) {
    worker.execute {
      try {
        if (session == null) {
          val file = File(ctx.filesDir, "smart_turn.onnx")
          if (!file.exists() || sha256(file) != sha256) {
            val tmp = File(ctx.filesDir, "smart_turn.onnx.download")
            val conn = URL(url).openConnection() as HttpURLConnection
            try {
              if (conn.responseCode != 200) {
                throw IllegalStateException(
                  "the server has no Smart Turn model ($url: HTTP ${conn.responseCode})",
                )
              }
              conn.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it) } }
            } finally {
              conn.disconnect()
            }
            if (sha256(tmp) != sha256) {
              tmp.delete()
              throw IllegalStateException(
                "the server's Smart Turn model does not match its pinned checksum",
              )
            }
            if (!tmp.renameTo(file)) throw IllegalStateException("could not keep the model")
          }
          val e = OrtEnvironment.getEnvironment()
          env = e
          session = e.createSession(file.absolutePath, OrtSession.SessionOptions())
        }
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("smart_turn_unavailable", e.message, e)
      }
    }
  }

  /** The probability the speaker has finished, from the end of the 16 kHz PCM. */
  @ReactMethod
  fun turnProbability(pcmBase64: String, promise: Promise) {
    worker.execute {
      try {
        val s = session ?: throw IllegalStateException("the model is not loaded")
        val bytes = Base64.decode(pcmBase64, Base64.NO_WRAP)
        val pcm = ShortArray(bytes.size / 2)
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(pcm)
        val features =
          SmartTurnFeatures.whisperFeatures(SmartTurnFeatures.lastEightSeconds(pcm))
        OnnxTensor.createTensor(
            env!!,
            FloatBuffer.wrap(features),
            longArrayOf(1, SmartTurnFeatures.N_MELS.toLong(), SmartTurnFeatures.N_FRAMES.toLong()),
          )
          .use { input ->
            s.run(mapOf("input_features" to input)).use { out ->
              val value = out[0].value
              val p =
                when (value) {
                  is Array<*> -> (value[0] as FloatArray)[0]
                  is FloatArray -> value[0]
                  else -> throw IllegalStateException("the model returned no probability")
                }
              if (!p.isFinite()) throw IllegalStateException("the model returned no probability")
              promise.resolve(p.coerceIn(0f, 1f).toDouble())
            }
          }
      } catch (e: Exception) {
        promise.reject("smart_turn_failed", e.message, e)
      }
    }
  }

  override fun invalidate() {
    main.post {
      finishPlayback()
      tts?.shutdown()
      tts = null
    }
    session?.close()
    worker.shutdown()
    super.invalidate()
  }
}
