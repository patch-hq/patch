package dev.patchhq.app

import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * JS-facing native module (`NativeModules.PatchVoiceAudioService`) that
 * starts / updates / stops the {@link VoiceAudioService} foreground service,
 * and forwards the notification's own button presses back to JS as
 * `PatchVoiceAudioAction` events ("mute" / "mode" / "stop" / "resume"), and
 * headphones coming and going ("headset_removed" / "headset_added").
 *
 * It also drives the call held by the service (src/lib/callTransport.ts): open
 * an attempt's [CallTransport], send it a control frame, flush its playback,
 * close it — and reports what happens on it as `PatchVoiceCall` events. And it
 * is the call's clock: timers kept on a native thread and fired as
 * `PatchVoiceTimer` events, because React Native stops JS timers while the app
 * is in the background, and the call's line (heartbeat watchdog, redial) has
 * to keep time with the phone locked.
 *
 * Consumed by src/lib/voiceAudioService.ts and src/lib/callTransport.ts. NO
 * FALLBACK: errors reject the returned Promise so the JS caller surfaces them
 * rather than continuing without a live foreground service or call.
 */
class PatchVoiceAudioServiceModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName(): String = "PatchVoiceAudioService"

  override fun initialize() {
    super.initialize()
    VoiceAudioService.actionListener = { action ->
      if (ctx.hasActiveReactInstance()) {
        ctx
          .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("PatchVoiceAudioAction", action)
      }
    }
  }

  override fun invalidate() {
    VoiceAudioService.actionListener = null
    VoiceAudioService.closeCall()
    clockThread.quitSafely()
    super.invalidate()
  }

  private fun emit(event: String, payload: Any) {
    if (!ctx.hasActiveReactInstance()) return
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(event, payload)
  }

  private fun callEvent(kind: String, id: Int, fill: WritableMap.() -> Unit = {}) {
    val map = Arguments.createMap()
    map.putString("kind", kind)
    map.putInt("id", id)
    map.fill()
    emit("PatchVoiceCall", map)
  }

  private val callEvents =
    object : CallTransport.Events {
      override fun onOpen(id: Int) = callEvent("open", id)

      override fun onFrame(id: Int, text: String) = callEvent("frame", id) { putString("text", text) }

      override fun onReplyAudio(id: Int, bytes: Int) =
        callEvent("reply_audio", id) { putInt("bytes", bytes) }

      override fun onClosed(id: Int, code: Int, reason: String, error: String?) {
        if (VoiceAudioService.call?.id == id) VoiceAudioService.call = null
        callEvent("closed", id) {
          putInt("code", code)
          putString("reason", reason)
          if (error != null) putString("error", error)
        }
      }

      override fun onMicError(id: Int, message: String) =
        callEvent("mic_error", id) { putString("message", message) }

      override fun onAudioStopped(id: Int, reason: String, detail: String) =
        callEvent("audio_stopped", id) {
          putString("reason", reason)
          putString("detail", detail)
        }
    }

  /**
   * Open attempt `id` of the call: dial `url`, send `startFrame` once it is
   * open, then stream the microphone. Closes any attempt still open.
   */
  @ReactMethod
  fun callOpen(id: Int, url: String, startFrame: String, promise: Promise) {
    try {
      VoiceAudioService.closeCall()
      val call = CallTransport(ctx.applicationContext, id, url, startFrame, callEvents)
      call.open()
      VoiceAudioService.call = call
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("call_open_failed", e.message, e)
    }
  }

  /** Send a control frame on attempt `id`; resolves false when that attempt has no open socket. */
  @ReactMethod
  fun callSend(id: Int, text: String, promise: Promise) {
    val call = VoiceAudioService.call
    promise.resolve(call != null && call.id == id && call.send(text))
  }

  /** Close attempt `id`, if it is the open one. */
  @ReactMethod
  fun callClose(id: Int, promise: Promise) {
    if (VoiceAudioService.call?.id == id) VoiceAudioService.closeCall()
    promise.resolve(null)
  }

  /** Drop the reply audio queued and playing on the open attempt. */
  @ReactMethod
  fun callFlush(promise: Promise) {
    VoiceAudioService.call?.flushPlayback()
    promise.resolve(null)
  }

  private val clockThread = HandlerThread("patch-voice-clock").apply { start() }
  private val clock = Handler(clockThread.looper)
  private val timers = HashMap<Int, Runnable>()

  /** Fire `PatchVoiceTimer` with `id` after `ms`, on a native thread. */
  @ReactMethod
  fun setTimer(id: Int, ms: Double) {
    val fire = Runnable {
      synchronized(timers) { timers.remove(id) }
      emit("PatchVoiceTimer", id)
    }
    synchronized(timers) { timers.put(id, fire) }?.let { clock.removeCallbacks(it) }
    clock.postDelayed(fire, ms.toLong())
  }

  @ReactMethod
  fun clearTimer(id: Int) {
    synchronized(timers) { timers.remove(id) }?.let { clock.removeCallbacks(it) }
  }

  /** Required by NativeEventEmitter; the emitting is done above. */
  @ReactMethod fun addListener(eventName: String) = Unit

  @ReactMethod fun removeListeners(count: Int) = Unit

  private fun send(
    action: String,
    chatName: String?,
    mode: String?,
    muted: Boolean,
    paused: Boolean,
    transientFocus: Boolean,
    firstStart: Boolean,
  ) {
    val intent =
      Intent(ctx, VoiceAudioService::class.java).apply {
        this.action = action
        putExtra(VoiceAudioService.EXTRA_CHAT, chatName)
        putExtra(VoiceAudioService.EXTRA_MODE, mode ?: "call")
        putExtra(VoiceAudioService.EXTRA_MUTED, muted)
        putExtra(VoiceAudioService.EXTRA_PAUSED, paused)
        putExtra(VoiceAudioService.EXTRA_TRANSIENT_FOCUS, transientFocus)
      }
    // Only the first start promotes the service to the foreground. An update goes
    // to a service that is already foreground — which makes this app count as in
    // the foreground for startService — so headphones going back in can resume a
    // paused call from the background, where startForegroundService is refused.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && firstStart) {
      ctx.startForegroundService(intent)
    } else {
      ctx.startService(intent)
    }
  }

  /**
   * `transientFocus` takes AUDIOFOCUS_GAIN_TRANSIENT rather than GAIN, for a
   * call answered on its own for an agent: other playback pauses for it and
   * resumes when it ends.
   */
  @ReactMethod
  fun start(
    chatName: String?,
    mode: String?,
    muted: Boolean,
    transientFocus: Boolean,
    promise: Promise,
  ) {
    try {
      send(VoiceAudioService.ACTION_START, chatName, mode, muted, false, transientFocus, true)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("voice_fg_start_failed", e.message, e)
    }
  }

  /**
   * Re-render the notification for a session that is already running — the
   * mode flipped, the mic was muted, or the call paused or resumed. Same START
   * path: the service is already foreground, so this only rebuilds the
   * notification and, on a pause or resume, releases or retakes the audio.
   */
  @ReactMethod
  fun update(
    chatName: String?,
    mode: String?,
    muted: Boolean,
    paused: Boolean,
    transientFocus: Boolean,
    promise: Promise,
  ) {
    try {
      send(VoiceAudioService.ACTION_START, chatName, mode, muted, paused, transientFocus, false)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("voice_fg_update_failed", e.message, e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      val intent =
        Intent(ctx, VoiceAudioService::class.java).apply {
          action = VoiceAudioService.ACTION_STOP
        }
      ctx.startService(intent)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("voice_fg_stop_failed", e.message, e)
    }
  }
}
