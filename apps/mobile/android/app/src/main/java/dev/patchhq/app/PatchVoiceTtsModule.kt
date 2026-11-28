package dev.patchhq.app

import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Playback of the host's streamed 24 kHz voice for a spoken alert
 * (`NativeModules.PatchVoiceTts`, src/lib/voiceTts.ts), on [PcmPlayer]. Chunks
 * arrive from JS as base64. A voice agent call does not use this: its reply
 * audio goes from the call's socket straight into [CallTransport]'s player.
 *
 * NO FALLBACK: a track that cannot initialise rejects the start Promise.
 */
class PatchVoiceTtsModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  companion object {
    const val TAG = "patch-voice"
  }

  private val player = PcmPlayer(ctx)
  @Volatile private var wroteFirst = false

  override fun getName(): String = "PatchVoiceTts"

  @ReactMethod
  fun start(promise: Promise) {
    try {
      wroteFirst = false
      player.start()
      promise.resolve(null)
    } catch (e: Throwable) {
      Log.e(TAG, "native tts: start failed: ${e.message}")
      promise.reject("tts_unavailable", e.message, e)
    }
  }

  @ReactMethod
  fun write(base64: String, promise: Promise) {
    try {
      player.write(Base64.decode(base64, Base64.DEFAULT))
      if (!wroteFirst) {
        Log.i(TAG, "native tts: first PCM chunk queued")
        wroteFirst = true
      }
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("tts_write_failed", e.message, e)
    }
  }

  /** Drop queued and in-flight audio. */
  @ReactMethod
  fun flush(promise: Promise) {
    player.flush()
    promise.resolve(null)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    player.stop()
    promise.resolve(null)
  }

  override fun invalidate() {
    player.stop()
    super.invalidate()
  }
}
