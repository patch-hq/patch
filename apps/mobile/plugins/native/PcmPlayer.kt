package dev.patchhq.app

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.util.Log
import java.util.concurrent.LinkedBlockingQueue

/**
 * Streaming playback of 24 kHz mono PCM16 — the voice the host streams back —
 * through an AudioTrack in MODE_STREAM, fed from a queue drained on its own
 * thread so the caller never blocks on AudioTrack.write. One implementation
 * for a call's transport ([CallTransport]) and a spoken alert
 * ([PatchVoiceTtsModule]).
 *
 * It holds transient-exclusive audio focus while it runs, so a podcast pauses
 * for the speech and resumes by itself afterwards. [flush] drops queued and
 * in-flight audio at once, for barge-in.
 *
 * NO FALLBACK: a track that cannot initialise throws from [start].
 */
class PcmPlayer(private val ctx: Context) {
  companion object {
    const val SAMPLE_RATE = 24000
    const val TAG = "patch-voice"
    // Enqueued to unblock the writer's take() on stop.
    private val POISON = ByteArray(0)
  }

  private var track: AudioTrack? = null
  @Volatile private var running = false
  private var writer: Thread? = null
  private val queue = LinkedBlockingQueue<ByteArray>()
  private var focusRequest: AudioFocusRequest? = null
  private var focusGranted = false

  @Synchronized
  fun start() {
    if (running) return
    val minBuf =
      AudioTrack.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (minBuf <= 0) throw IllegalStateException("AudioTrack.getMinBufferSize returned $minBuf")
    // ~0.5 s of headroom (SAMPLE_RATE * 2 bytes = 1 s) smooths jitter without
    // adding audible latency to the reply.
    val t =
      AudioTrack.Builder()
        .setAudioAttributes(
          AudioAttributes.Builder()
            // The call's VOICE_COMMUNICATION route (earpiece / headset), not media.
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        )
        .setAudioFormat(
          AudioFormat.Builder()
            .setSampleRate(SAMPLE_RATE)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build(),
        )
        .setBufferSizeInBytes(maxOf(minBuf, SAMPLE_RATE))
        .setTransferMode(AudioTrack.MODE_STREAM)
        .build()
    if (t.state != AudioTrack.STATE_INITIALIZED) {
      t.release()
      throw IllegalStateException("AudioTrack failed to initialise")
    }
    track = t
    running = true
    queue.clear()
    requestFocus()
    t.play()
    Log.i(TAG, "player: AudioTrack started (24kHz mono PCM16, MODE_STREAM, VOICE_COMMUNICATION)")
    val w = Thread({ writeLoop(t) }, "patch-voice-player")
    w.start()
    writer = w
  }

  private fun writeLoop(t: AudioTrack) {
    while (running) {
      val chunk =
        try {
          queue.take()
        } catch (_: InterruptedException) {
          break
        }
      if (chunk.isEmpty()) continue // poison; the loop re-checks running
      var off = 0
      while (off < chunk.size && running) {
        val n = t.write(chunk, off, chunk.size - off)
        if (n < 0) {
          Log.e(TAG, "player: AudioTrack.write returned $n; playback stopped")
          running = false
          break
        }
        off += n
      }
    }
  }

  /** Queue one chunk. Odd trailing bytes are dropped: PCM16 is two bytes a sample. */
  fun write(pcm: ByteArray) {
    if (!running) throw IllegalStateException("PcmPlayer.write before start")
    val usable = pcm.size - (pcm.size % 2)
    if (usable == 0) return
    queue.offer(if (usable == pcm.size) pcm else pcm.copyOf(usable))
  }

  /** Barge-in: drop queued and in-flight audio so the cut-off reply stops now. */
  fun flush() {
    queue.clear()
    try {
      track?.pause()
      track?.flush()
      track?.play()
    } catch (_: Throwable) {
      // Track already stopped — nothing to flush.
    }
  }

  /** Stop playback and release the track. Idempotent. */
  @Synchronized
  fun stop() {
    running = false
    queue.clear()
    queue.offer(POISON)
    try {
      writer?.join(500)
    } catch (_: InterruptedException) {
      // Best effort; the track is released below regardless.
    }
    writer = null
    try {
      track?.pause()
      track?.flush()
      track?.stop()
    } catch (_: Throwable) {
      // Never started or already stopped — release is the source of truth.
    }
    track?.release()
    track = null
    abandonFocus()
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
          .build()
      result = manager.requestAudioFocus(request)
      if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) focusRequest = request
    } else {
      @Suppress("DEPRECATION")
      result =
        manager.requestAudioFocus(
          null,
          AudioManager.STREAM_VOICE_CALL,
          AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE,
        )
    }
    if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      Log.w(TAG, "player: audio focus not granted (result=$result)")
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
      @Suppress("DEPRECATION") manager.abandonAudioFocus(null)
    }
  }
}
