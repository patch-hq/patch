package dev.patchhq.app

import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.Uri
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * The call's own sounds (`NativeModules.PatchCallSounds`, spec/07 § Call
 * sounds): connecting, connected, reconnecting, ended and the rest, played from
 * the bundled files by src/lib/callSounds.ts.
 *
 * They are part of the call, so they play as call signalling
 * (USAGE_VOICE_COMMUNICATION_SIGNALLING, routed with the call to a headset) and
 * take no audio focus of their own. A player that asked for focus would lose it
 * to the call the moment the call took its own — which is what silenced the
 * connecting sound a few milliseconds after it started — and would in turn
 * take it from the call's microphone each time a cue played.
 *
 * A one-off sound is released when it finishes; a looping one plays until
 * stopped. NO FALLBACK: a sound that cannot be loaded rejects.
 */
class PatchCallSoundsModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  companion object {
    const val TAG = "patch-voice"
  }

  private val loops = HashMap<String, MediaPlayer>()

  override fun getName(): String = "PatchCallSounds"

  /**
   * The bundled file behind `uri`: a `file://` (or other scheme) URI as an
   * update ships it, or the bare resource name an embedded asset resolves to.
   */
  private fun source(uri: String): Uri {
    if (uri.contains("://")) return Uri.parse(uri)
    val id = ctx.resources.getIdentifier(uri, "raw", ctx.packageName)
    if (id == 0) throw IllegalArgumentException("no bundled sound called $uri")
    return Uri.parse("android.resource://${ctx.packageName}/$id")
  }

  private fun player(uri: String, loop: Boolean): MediaPlayer {
    val p = MediaPlayer()
    try {
      p.setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build()
      )
      p.setDataSource(ctx, source(uri))
      p.isLooping = loop
      p.prepare()
    } catch (e: Throwable) {
      p.release()
      throw e
    }
    return p
  }

  /** Play a one-off sound once. */
  @ReactMethod
  fun play(uri: String, promise: Promise) {
    try {
      val p = player(uri, false)
      p.setOnCompletionListener { it.release() }
      p.start()
      promise.resolve(null)
    } catch (e: Throwable) {
      Log.e(TAG, "call sound: $uri failed: ${e.message}")
      promise.reject("call_sound_failed", e.message, e)
    }
  }

  /** Start the looping sound `name`; one already playing goes on. */
  @ReactMethod
  fun startLoop(name: String, uri: String, promise: Promise) {
    try {
      synchronized(loops) {
        if (!loops.containsKey(name)) {
          val p = player(uri, true)
          p.start()
          loops[name] = p
        }
      }
      promise.resolve(null)
    } catch (e: Throwable) {
      Log.e(TAG, "call sound: $name loop failed: ${e.message}")
      promise.reject("call_sound_failed", e.message, e)
    }
  }

  @ReactMethod
  fun stopLoop(name: String, promise: Promise) {
    val p = synchronized(loops) { loops.remove(name) }
    try {
      p?.stop()
    } catch (_: IllegalStateException) {
      // Never started — releasing is all there is to do.
    }
    p?.release()
    promise.resolve(null)
  }

  override fun invalidate() {
    synchronized(loops) {
      for (p in loops.values) p.release()
      loops.clear()
    }
    super.invalidate()
  }
}
