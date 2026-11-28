package dev.patchhq.app

import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * The microphone for what the phone listens to in JS (`NativeModules.PatchVoiceMic`):
 * dictation, a voice note's live words and a direct call. Each ~40 ms frame of
 * [MicCapture] goes to JS as a base64 `PatchVoiceMicFrame` event, decoded by
 * src/lib/voiceMic.ts. A voice agent call does not use this: its frames go
 * straight up the call's socket from [CallTransport], never through JS.
 *
 * NO FALLBACK: a microphone that cannot open rejects the start Promise, and a
 * mid-stream read error emits an `error` frame.
 */
class PatchVoiceMicModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  companion object {
    const val EVENT = "PatchVoiceMicFrame"
    const val TAG = "patch-voice"
    /**
     * A second reader of every frame, on the read thread — the phone's own
     * recogniser ([PatchSpeechModule]) hears the same audio without opening
     * the microphone a second time.
     */
    @Volatile var tap: ((ByteArray) -> Unit)? = null
  }

  private val capture =
    MicCapture(
      ctx,
      object : MicCapture.Listener {
        override fun onFrame(pcm: ByteArray) {
          tap?.invoke(pcm.copyOf())
          val map = Arguments.createMap()
          map.putString("base64", Base64.encodeToString(pcm, Base64.NO_WRAP))
          map.putInt("samples", MicCapture.FRAME_SAMPLES)
          emit(map)
        }

        override fun onError(message: String) {
          val map = Arguments.createMap()
          map.putString("error", message)
          emit(map)
        }

        override fun onAudioStopped(reason: String, detail: String) {
          val map = Arguments.createMap()
          map.putString("audioStopped", reason)
          map.putString("detail", detail)
          emit(map)
        }
      },
    )

  override fun getName(): String = "PatchVoiceMic"

  // RN NativeEventEmitter compliance.
  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}

  private fun emit(map: WritableMap) {
    try {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(EVENT, map)
    } catch (_: Throwable) {
      // React instance torn down mid-frame — nothing to deliver to.
    }
  }

  @ReactMethod
  fun start(promise: Promise) {
    try {
      capture.start()
      promise.resolve(null)
    } catch (e: Throwable) {
      Log.e(TAG, "native mic: start failed: ${e.message}")
      promise.reject("mic_unavailable", e.message, e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    capture.stop()
    promise.resolve(null)
  }

  override fun invalidate() {
    capture.stop()
    super.invalidate()
  }
}
