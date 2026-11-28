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
 * Every sound is prepared once at app start (`preload`) and kept ready, so
 * starting one is a bare `start()` with no file open, decode or prepare in
 * between: the connecting sound has to begin on the press, not a few seconds
 * after it. A looping one plays until stopped. NO FALLBACK: a sound that cannot
 * be loaded, or that was never preloaded, rejects.
 */
class PatchCallSoundsModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  companion object {
    const val TAG = "patch-voice"
  }

  private val players = HashMap<String, MediaPlayer>()

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

  private fun prepared(uri: String, loop: Boolean): MediaPlayer {
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

  /** Prepare the sound `name` from `uri`, replacing any earlier copy. Called for each at app start. */
  @ReactMethod
  fun preload(name: String, uri: String, loop: Boolean, promise: Promise) {
    try {
      val p = prepared(uri, loop)
      synchronized(players) { players.put(name, p) }?.release()
      promise.resolve(null)
    } catch (e: Throwable) {
      Log.e(TAG, "call sound: $name preload failed: ${e.message}")
      promise.reject("call_sound_failed", e.message, e)
    }
  }

  private fun ready(name: String): MediaPlayer =
    synchronized(players) { players[name] }
      ?: throw IllegalStateException("call sound $name was not preloaded")

  /** Start `name` from the top; a looping one plays until stopped. */
  @ReactMethod
  fun start(name: String, promise: Promise) {
    try {
      val p = ready(name)
      if (p.isPlaying) {
        // A one-off already sounding restarts; a loop already playing goes on.
        if (!p.isLooping) p.seekTo(0)
      } else {
        p.seekTo(0)
        p.start()
      }
      promise.resolve(null)
    } catch (e: Throwable) {
      Log.e(TAG, "call sound: $name failed: ${e.message}")
      promise.reject("call_sound_failed", e.message, e)
    }
  }

  @ReactMethod
  fun stop(name: String, promise: Promise) {
    try {
      val p = ready(name)
      if (p.isPlaying) p.pause()
      p.seekTo(0)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("call_sound_failed", e.message, e)
    }
  }

  override fun invalidate() {
    synchronized(players) {
      for (p in players.values) p.release()
      players.clear()
    }
    super.invalidate()
  }
}
