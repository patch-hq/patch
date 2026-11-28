package dev.patchhq.app

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * The microphone at the host's canonical 16 kHz mono PCM16, read on its own
 * thread in ~40 ms frames. One implementation for everything on the phone that
 * listens: a call's transport ([CallTransport]) sends each frame straight up
 * its socket, and [PatchVoiceMicModule] hands frames to JS for dictation, voice
 * notes and direct calls.
 *
 * While it runs it holds transient-exclusive audio focus (so music pauses while
 * the user talks) and reports, through [Listener.onAudioStopped], the two
 * things that stop audio without failing the capture: another app taking the
 * focus, and an audio device coming or going (spec/07 § Call logs).
 *
 * NO FALLBACK: an AudioRecord that cannot initialise throws from [start]; a
 * read that fails mid-stream reports [Listener.onError] and stops.
 */
class MicCapture(private val ctx: Context, private val listener: Listener) {
  interface Listener {
    /** One whole frame, [FRAME_BYTES] long, owned by the callee. On the read thread. */
    fun onFrame(pcm: ByteArray)

    fun onError(message: String)

    fun onAudioStopped(reason: String, detail: String)
  }

  companion object {
    const val SAMPLE_RATE = 16000
    // 40 ms @ 16 kHz mono = 640 samples = 1280 bytes. The host VADs on whatever
    // arrives, so the exact size is not load-bearing.
    const val FRAME_SAMPLES = 640
    const val FRAME_BYTES = FRAME_SAMPLES * 2
    const val TAG = "patch-voice"
  }

  private var record: AudioRecord? = null
  @Volatile private var running = false
  private var thread: Thread? = null
  private var focusRequest: AudioFocusRequest? = null
  private var focusGranted = false
  private var devicesWatched = false

  val isRunning: Boolean
    get() = running

  private val focusListener =
    AudioManager.OnAudioFocusChangeListener { change ->
      val what =
        when (change) {
          AudioManager.AUDIOFOCUS_LOSS -> "AUDIOFOCUS_LOSS"
          AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> "AUDIOFOCUS_LOSS_TRANSIENT"
          AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> "AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK"
          else -> null
        }
      if (what != null && running) audioStopped("audio_focus_taken", what)
    }

  // Registering reports every device already present; only changes after that count.
  private val deviceCallback =
    object : AudioDeviceCallback() {
      private var primed = false

      override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) {
        if (!primed) {
          primed = true
          return
        }
        if (running) audioStopped("output_device_changed", "added ${describe(added)}")
      }

      override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) {
        if (running) audioStopped("output_device_changed", "removed ${describe(removed)}")
      }
    }

  private fun describe(devices: Array<out AudioDeviceInfo>): String =
    devices.joinToString(", ") { "${it.productName} (type ${it.type})" }

  private fun audioStopped(reason: String, detail: String) {
    Log.i(TAG, "mic: audio stopped ($reason): $detail")
    listener.onAudioStopped(reason, detail)
  }

  /** Open the microphone and start reading. Throws when it cannot be opened. */
  @Synchronized
  fun start() {
    if (running) return
    val minBuf =
      AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (minBuf <= 0) throw IllegalStateException("AudioRecord.getMinBufferSize returned $minBuf")
    // A generous buffer (>= 4 frames) so a scheduling hiccup on the read thread
    // doesn't overrun and drop samples.
    val rec =
      AudioRecord(
        // VOICE_COMMUNICATION engages the platform's echo cancel and noise
        // suppression — spec/07 relies on device-side AEC (surfaceHasAec=true).
        MediaRecorder.AudioSource.VOICE_COMMUNICATION,
        SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        maxOf(minBuf, FRAME_BYTES * 4),
      )
    if (rec.state != AudioRecord.STATE_INITIALIZED) {
      rec.release()
      throw IllegalStateException(
        "AudioRecord failed to initialise (mic permission denied or device in use)"
      )
    }
    try {
      record = rec
      running = true
      watchDevices()
      requestFocus()
      rec.startRecording()
    } catch (e: Throwable) {
      stop()
      throw e
    }
    Log.i(TAG, "mic: AudioRecord started (16kHz mono PCM16, VOICE_COMMUNICATION)")
    val t = Thread({ readLoop(rec) }, "patch-voice-mic")
    t.start()
    thread = t
  }

  private fun readLoop(rec: AudioRecord) {
    var firstFrame = true
    while (running) {
      val buf = ByteArray(FRAME_BYTES)
      // AudioRecord.read may return fewer bytes than asked for; fill a whole
      // frame so the receiver always sees complete PCM16 frames.
      var off = 0
      while (off < FRAME_BYTES && running) {
        val n = rec.read(buf, off, FRAME_BYTES - off)
        if (n <= 0) {
          // ERROR_INVALID_OPERATION (-3) / ERROR_BAD_VALUE (-2) / DEAD_OBJECT.
          if (running) {
            Log.e(TAG, "mic: read loop error: AudioRecord.read returned $n")
            listener.onError("AudioRecord.read returned $n")
          }
          return
        }
        off += n
      }
      if (!running) break
      if (firstFrame) {
        Log.i(TAG, "mic: first PCM frame captured")
        firstFrame = false
      }
      listener.onFrame(buf)
    }
  }

  /** Stop reading and release the microphone. Idempotent. */
  @Synchronized
  fun stop() {
    running = false
    val t = thread
    thread = null
    if (t != null && t !== Thread.currentThread()) {
      try {
        t.join(500)
      } catch (_: InterruptedException) {
        // Best effort; the record is released below regardless.
      }
    }
    try {
      record?.stop()
    } catch (_: Throwable) {
      // Never started or already stopped — release is the source of truth.
    }
    record?.release()
    record = null
    abandonFocus()
    unwatchDevices()
  }

  private fun watchDevices() {
    if (devicesWatched) return
    val manager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    manager.registerAudioDeviceCallback(deviceCallback, Handler(Looper.getMainLooper()))
    devicesWatched = true
  }

  private fun unwatchDevices() {
    if (!devicesWatched) return
    val manager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    manager.unregisterAudioDeviceCallback(deviceCallback)
    devicesWatched = false
  }

  private fun requestFocus() {
    if (focusGranted) return
    val manager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val result: Int
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request =
        AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
          .setAudioAttributes(
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
              .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
              .build(),
          )
          .setWillPauseWhenDucked(false)
          .setOnAudioFocusChangeListener(focusListener)
          .build()
      result = manager.requestAudioFocus(request)
      if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) focusRequest = request
    } else {
      @Suppress("DEPRECATION")
      result =
        manager.requestAudioFocus(
          focusListener,
          AudioManager.STREAM_VOICE_CALL,
          AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE,
        )
    }
    if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      Log.w(TAG, "mic: audio focus not granted (result=$result)")
      return
    }
    focusGranted = true
  }

  private fun abandonFocus() {
    if (!focusGranted) return
    focusGranted = false
    val manager = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val request = focusRequest
    focusRequest = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && request != null) {
      manager.abandonAudioFocusRequest(request)
    } else {
      @Suppress("DEPRECATION") manager.abandonAudioFocus(focusListener)
    }
  }
}
