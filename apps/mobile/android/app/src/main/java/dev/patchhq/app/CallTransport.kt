package dev.patchhq.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

/**
 * One attempt's audio session for a voice agent call, run entirely on native
 * threads (spec/07 § A call keeps going in the background): the socket, the
 * microphone streaming up it, the answer to every host heartbeat and the
 * playback of the reply. Nothing that keeps the call alive waits on JS, which
 * Android throttles and React Native stops timing once the app is in the
 * background or the screen is locked. JS drives it (open, send a control
 * frame, close) and is told what happens, to run the call's line and show it.
 *
 * - On open it sends the `audio.session_start` frame it was given, then opens
 *   the microphone and streams each frame up, unless the call is muted
 *   ([VoiceAudioService.muted]).
 * - A heartbeat is echoed on the socket's thread as it arrives; every text
 *   frame then goes to JS. A barge-in flushes playback here, at once.
 * - Binary frames are the reply's audio and go straight to the player; JS is
 *   told once per reply that audio has started.
 *
 * NO FALLBACK: a microphone that cannot open, or opens and delivers nothing,
 * is reported, never left as a live-looking call that carries no audio.
 */
class CallTransport(
  private val ctx: Context,
  val id: Int,
  private val url: String,
  private val startFrame: String,
  private val events: Events,
) {
  interface Events {
    fun onOpen(id: Int)

    fun onFrame(id: Int, text: String)

    /** The first audio of a reply arrived (once per reply). */
    fun onReplyAudio(id: Int, bytes: Int)

    /** The socket is gone; `error` set when it failed rather than closed. */
    fun onClosed(id: Int, code: Int, reason: String, error: String?)

    fun onMicError(id: Int, message: String)

    fun onAudioStopped(id: Int, reason: String, detail: String)
  }

  companion object {
    const val TAG = "patch-voice"
    /** How long an opened microphone may go without a frame before it is reported dead. */
    const val MIC_FIRST_FRAME_TIMEOUT_MS = 3000L

    private val client: OkHttpClient by lazy {
      OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        // A call is open for as long as it lasts; the heartbeat judges the line.
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    }
  }

  private val main = Handler(Looper.getMainLooper())
  private val player = PcmPlayer(ctx)
  @Volatile private var ws: WebSocket? = null
  @Volatile private var closed = false
  @Volatile private var micFrames = 0L
  @Volatile private var replyStarted = false

  private val mic =
    MicCapture(
      ctx,
      object : MicCapture.Listener {
        override fun onFrame(pcm: ByteArray) = sendMic(pcm)

        override fun onError(message: String) {
          if (!closed) events.onMicError(id, message)
        }

        override fun onAudioStopped(reason: String, detail: String) {
          if (!closed) events.onAudioStopped(id, reason, detail)
        }
      },
    )

  private val micWatchdog = Runnable {
    if (!closed && micFrames == 0L) {
      events.onMicError(id, "the microphone opened but delivered no audio")
    }
  }

  /** Start the player and dial. Throws when the player cannot start. */
  fun open() {
    player.start()
    ws = client.newWebSocket(Request.Builder().url(url).build(), listener)
    Log.i(TAG, "call[$id]: dialling $url")
  }

  /** Send a control frame from JS; false when the socket is gone. */
  fun send(text: String): Boolean {
    val socket = ws ?: return false
    return !closed && socket.send(text)
  }

  fun flushPlayback() = player.flush()

  /** Close this attempt: socket, microphone and playback. Idempotent. */
  fun close() {
    ws?.close(1000, null)
    teardown()
  }

  private fun teardown() {
    if (closed) return
    closed = true
    main.removeCallbacks(micWatchdog)
    mic.stop()
    player.stop()
  }

  private fun sendMic(pcm: ByteArray) {
    if (closed) return
    micFrames += 1
    if (micFrames == 1L) Log.i(TAG, "call[$id]: first mic frame sent up")
    if (VoiceAudioService.muted) return
    val socket = ws ?: return
    // OkHttp queues sends; false means the socket is closing or its queue is full.
    if (
      !socket.send(CallFrames.micHeader(System.currentTimeMillis(), MicCapture.FRAME_SAMPLES)) ||
        !socket.send(pcm.toByteString())
    ) {
      Log.w(TAG, "call[$id]: mic frame not sent; the socket is going")
      socket.cancel()
    }
  }

  private val listener =
    object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        if (closed) return
        Log.i(TAG, "call[$id]: socket open; session_start sent, opening the microphone")
        webSocket.send(startFrame)
        events.onOpen(id)
        try {
          mic.start()
          main.postDelayed(micWatchdog, MIC_FIRST_FRAME_TIMEOUT_MS)
        } catch (e: Throwable) {
          events.onMicError(id, "mic unavailable: ${e.message}")
        }
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        if (closed) return
        replyStarted = false
        val echo = CallFrames.heartbeatEcho(text)
        if (echo != null) webSocket.send(echo)
        else if (CallFrames.typeOf(text) == CallFrames.BARGE_IN) player.flush()
        events.onFrame(id, text)
      }

      override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        if (closed) return
        player.write(bytes.toByteArray())
        if (!replyStarted) {
          replyStarted = true
          events.onReplyAudio(id, bytes.size)
        }
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(code, null)
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        val wasOpen = !closed
        teardown()
        Log.i(TAG, "call[$id]: socket closed $code $reason")
        if (wasOpen) events.onClosed(id, code, reason, null)
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        val wasOpen = !closed
        teardown()
        Log.w(TAG, "call[$id]: socket failed: ${t.message}")
        if (wasOpen) events.onClosed(id, 1006, "", t.message ?: t.javaClass.simpleName)
      }
    }
}
