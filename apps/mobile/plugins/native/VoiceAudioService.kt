package dev.patchhq.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * Foreground service that keeps the voice session (mic + audio focus) alive
 * while the app is backgrounded — required by Android for any app that
 * records audio off-screen (spec/15 ## Native specifics: "Foreground service
 * while voice is active (OS requires it)").
 *
 * The persistent notification is the CONTROL SURFACE for a phone the user is
 * not looking at (spec/15 § Voice tab): it names the mode and carries
 * Mute, a mode switch and End call. Those actions come back to JS
 * through {@link actionListener} so the app state and the notification never
 * disagree — a notification button that only changed the notification would be
 * a lie about what the call is doing.
 *
 * Audio focus is requested as AUDIOFOCUS_GAIN, so music and navigation prompts
 * duck for the session rather than playing over it. A call answered on its own
 * for an agent (Answer automatically in hands-free) takes
 * AUDIOFOCUS_GAIN_TRANSIENT instead: the other app pauses for it and resumes by
 * itself when the call ends and focus is abandoned. A hands-free session holds
 * the same service and the same focus: silence is not the same as being
 * finished, and a session Android drops while the phone is in a pocket is the
 * failure this prevents.
 *
 * A paused call (spec/07 § Pause) keeps the service: the voice session is
 * closed, focus and the headset route are released so other audio plays again,
 * and the notification reads Paused with Resume and End. The service stays so
 * that headphones going back in can resume the call from the background —
 * Android only lets the microphone start again under a service that is
 * already running.
 *
 * Headphones coming and going are reported to JS ("headset_removed" /
 * "headset_added"), which pauses and resumes the call.
 *
 * The call itself lives here too, on native threads: [call] is the open
 * attempt's [CallTransport] (socket, microphone, heartbeat echo, playback), so
 * the call keeps going with the screen off, the phone locked or the app in the
 * background (spec/07 § A call keeps going in the background). While a call is
 * not paused the service holds a partial wake lock, so the CPU keeps the
 * socket answered and the call's clock (PatchVoiceAudioServiceModule's timers)
 * running when the screen is off.
 *
 * Started/stopped from JS via PatchVoiceAudioServiceModule. NO FALLBACK: if
 * the platform refuses to promote us to foreground we throw, surfacing the
 * failure rather than silently dropping background audio.
 */
class VoiceAudioService : Service() {
  companion object {
    const val CHANNEL_ID = "patch_voice_fg"
    const val NOTIFICATION_ID = 4711
    const val EXTRA_CHAT = "chat"
    const val EXTRA_MODE = "mode"
    const val EXTRA_MUTED = "muted"
    const val EXTRA_PAUSED = "paused"
    const val EXTRA_TRANSIENT_FOCUS = "transientFocus"
    const val ACTION_START = "dev.patchhq.app.voice.START"
    const val ACTION_STOP = "dev.patchhq.app.voice.STOP"
    /**
     * The notification's own End call button, as distinct from ACTION_STOP,
     * which is JS tearing the service down. Only this one tells JS to end the
     * call — routing both through one action would have JS's own teardown
     * bounce straight back at it as a fresh end-the-call request.
     */
    const val ACTION_END_FROM_NOTIFICATION = "dev.patchhq.app.voice.END"
    const val ACTION_MUTE = "dev.patchhq.app.voice.MUTE"
    const val ACTION_MODE = "dev.patchhq.app.voice.MODE"
    const val ACTION_RESUME = "dev.patchhq.app.voice.RESUME"

    /**
     * Set by PatchVoiceAudioServiceModule while the React context is alive.
     * The service calls it with the bare action name when the user presses one
     * of the notification's buttons; JS owns what that means.
     */
    @Volatile var actionListener: ((String) -> Unit)? = null

    /** The call is muted: the transport stops sending microphone frames. Set from every start and update. */
    @Volatile var muted: Boolean = false

    /** The open attempt of a voice agent call, while one is open. */
    @Volatile var call: CallTransport? = null

    /** Close the open attempt, if any. */
    fun closeCall() {
      val c = call
      call = null
      c?.close()
    }
  }

  private var wakeLock: PowerManager.WakeLock? = null

  private var focusRequest: AudioFocusRequest? = null
  private var previousMode: Int? = null
  private var scoStarted = false
  private var deviceCallbackRegistered = false
  private var chat: String? = null
  private var mode: String = "call"
  private var muted: Boolean = false
  private var paused: Boolean = false
  private var transientFocus: Boolean = false
  private var inForeground = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_END_FROM_NOTIFICATION -> {
        // A press on End call has to end the CALL, not just the service —
        // otherwise the app is left holding a session with no notification.
        actionListener?.invoke("stop")
        closeCall()
        releaseWakeLock()
        stopWatchingHeadsets()
        releaseHeadsetRoute()
        abandonAudioFocus()
        stopForegroundCompat()
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_STOP -> {
        closeCall()
        releaseWakeLock()
        stopWatchingHeadsets()
        releaseHeadsetRoute()
        abandonAudioFocus()
        stopForegroundCompat()
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_MUTE -> {
        actionListener?.invoke("mute")
        return START_STICKY
      }
      ACTION_MODE -> {
        actionListener?.invoke("mode")
        return START_STICKY
      }
      ACTION_RESUME -> {
        actionListener?.invoke("resume")
        return START_STICKY
      }
    }
    if (intent != null) {
      chat = intent.getStringExtra(EXTRA_CHAT)
      mode = intent.getStringExtra(EXTRA_MODE) ?: "call"
      muted = intent.getBooleanExtra(EXTRA_MUTED, false)
      Companion.muted = muted
      paused = intent.getBooleanExtra(EXTRA_PAUSED, false)
      transientFocus = intent.getBooleanExtra(EXTRA_TRANSIENT_FOCUS, false)
    }
    ensureChannel()
    watchHeadsetChanges()
    if (paused) {
      // Nothing is listening or speaking: give the audio back to everything else.
      releaseHeadsetRoute()
      abandonAudioFocus()
      releaseWakeLock()
    } else {
      requestAudioFocus()
      routeToHeadset()
      acquireWakeLock()
    }
    if (!inForeground) {
      startForeground(NOTIFICATION_ID, buildNotification())
      inForeground = true
    } else {
      // Already foreground: redraw the notification only. Promoting again would
      // re-check the microphone type, which Android refuses from the background —
      // and headphones going back in resumes a paused call from exactly there.
      val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      mgr.notify(NOTIFICATION_ID, buildNotification())
    }
    return START_STICKY
  }

  override fun onDestroy() {
    closeCall()
    releaseWakeLock()
    stopWatchingHeadsets()
    releaseHeadsetRoute()
    abandonAudioFocus()
    super.onDestroy()
  }

  private fun acquireWakeLock() {
    if (wakeLock != null) return
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    val lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "patch:voice-call")
    lock.setReferenceCounted(false)
    lock.acquire()
    wakeLock = lock
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  private fun requestAudioFocus() {
    if (focusRequest != null) return
    val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val attributes =
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      val request =
        AudioFocusRequest.Builder(focusGain())
          .setAudioAttributes(attributes)
          .setWillPauseWhenDucked(false)
          .build()
      focusRequest = request
      manager.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      manager.requestAudioFocus(
        null,
        AudioManager.STREAM_VOICE_CALL,
        focusGain(),
      )
    }
  }

  // Transient for a call answered on its own for an agent: the app it paused
  // resumes when focus is abandoned at the end of the call.
  private fun focusGain(): Int =
    if (transientFocus) AudioManager.AUDIOFOCUS_GAIN_TRANSIENT else AudioManager.AUDIOFOCUS_GAIN

  // VOICE_COMMUNICATION audio follows the call route, which only reaches a
  // wired or Bluetooth headset once Android is in communication mode and that
  // device is chosen. Without this the reply plays from the phone speaker.
  private fun routeToHeadset() {
    if (paused) return
    val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    if (previousMode == null) previousMode = manager.mode
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    val headset = headsetTypes
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val device = manager.availableCommunicationDevices.firstOrNull { it.type in headset }
      if (device == null) {
        Log.i("PatchVoiceAudio", "no headset connected; using the phone's own route")
      } else if (!manager.setCommunicationDevice(device)) {
        Log.w("PatchVoiceAudio", "setCommunicationDevice refused ${device.type}")
      }
    } else {
      @Suppress("DEPRECATION")
      if (manager.isWiredHeadsetOn) {
        manager.isSpeakerphoneOn = false
      } else if (manager.isBluetoothScoAvailableOffCall) {
        manager.startBluetoothSco()
        scoStarted = true
      }
    }
  }

  // Headphones out pauses the call and back in resumes it (spec/07 § Pause):
  // JS owns that decision and is told of each change. A headset connected while
  // the call is live also takes the call onto it now, since the route is
  // otherwise chosen once at start. A headset removed is not rerouted to the
  // phone's speaker: the call is pausing, and the reply must not play out loud
  // in the meantime. With no JS to tell (the React context gone), the call is
  // moved to the phone's own route rather than left on a device that is gone.
  private val deviceCallback =
    object : AudioDeviceCallback() {
      override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) {
        if (removed.any { it.type in headsetTypes }) {
          val listener = actionListener
          if (listener != null) {
            Log.i("PatchVoiceAudio", "headset removed (paused=$paused); telling JS")
            listener.invoke("headset_removed")
          } else if (!paused) {
            Log.w("PatchVoiceAudio", "headset removed with no JS listening; moving to the phone's route")
            rerouteAfterDeviceChange()
          }
        }
      }

      override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) {
        if (added.any { it.type in headsetTypes }) {
          Log.i("PatchVoiceAudio", "headset connected (paused=$paused)")
          if (!paused) rerouteAfterDeviceChange()
          actionListener?.invoke("headset_added")
        }
      }
    }

  private fun watchHeadsetChanges() {
    if (deviceCallbackRegistered) return
    val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    manager.registerAudioDeviceCallback(deviceCallback, Handler(Looper.getMainLooper()))
    deviceCallbackRegistered = true
  }

  private fun rerouteAfterDeviceChange() {
    val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      manager.clearCommunicationDevice()
    } else if (scoStarted) {
      @Suppress("DEPRECATION") manager.stopBluetoothSco()
      scoStarted = false
    }
    routeToHeadset()
  }

  private fun stopWatchingHeadsets() {
    if (!deviceCallbackRegistered) return
    val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    manager.unregisterAudioDeviceCallback(deviceCallback)
    deviceCallbackRegistered = false
  }

  private fun releaseHeadsetRoute() {
    val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      manager.clearCommunicationDevice()
    } else if (scoStarted) {
      @Suppress("DEPRECATION") manager.stopBluetoothSco()
      scoStarted = false
    }
    previousMode?.let { manager.mode = it }
    previousMode = null
  }

  private val headsetTypes =
    setOf(
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
    )

  private fun abandonAudioFocus() {
    val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val request = focusRequest
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && request != null) {
      manager.abandonAudioFocusRequest(request)
    } else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      @Suppress("DEPRECATION") manager.abandonAudioFocus(null)
    }
    focusRequest = null
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
        val channel =
          NotificationChannel(
            CHANNEL_ID,
            "Patch voice session",
            NotificationManager.IMPORTANCE_LOW,
          )
        channel.setShowBadge(false)
        mgr.createNotificationChannel(channel)
      }
    }
  }

  private fun serviceAction(action: String, requestCode: Int): PendingIntent {
    val intent = Intent(this, VoiceAudioService::class.java).apply { this.action = action }
    return PendingIntent.getService(
      this,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun buildNotification(): Notification {
    val open =
      packageManager.getLaunchIntentForPackage(packageName)?.apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
      }
    val contentIntent =
      PendingIntent.getActivity(
        this,
        0,
        open ?: Intent(),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    val handsFree = mode == "hands-free"
    val label = if (paused) "Paused" else if (handsFree) "Hands-free" else "On call"
    val status = if (chat.isNullOrBlank()) label else "$label · $chat"

    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(this, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION") Notification.Builder(this)
      }

    builder
      .setContentTitle("Patch")
      .setContentText(status)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setContentIntent(contentIntent)
    if (paused) {
      return builder
        .addAction(
          Notification.Action.Builder(0, "Resume", serviceAction(ACTION_RESUME, 4)).build()
        )
        .addAction(
          Notification.Action.Builder(0, "End call", serviceAction(ACTION_END_FROM_NOTIFICATION, 1))
            .build()
        )
        .build()
    }
    return builder
      .addAction(
        Notification.Action.Builder(
            0,
            if (muted) "Unmute" else "Mute",
            serviceAction(ACTION_MUTE, 2),
          )
          .build()
      )
      .addAction(
        Notification.Action.Builder(
            0,
            if (handsFree) "Take the call" else "Hands-free",
            serviceAction(ACTION_MODE, 3),
          )
          .build()
      )
      .addAction(
        Notification.Action.Builder(
            0,
            "End call",
            serviceAction(ACTION_END_FROM_NOTIFICATION, 1),
          )
          .build()
      )
      .build()
  }

  private fun stopForegroundCompat() {
    inForeground = false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION") stopForeground(true)
    }
  }
}
