package dev.patchhq.app

import org.json.JSONException
import org.json.JSONObject

/**
 * The audio-session text frames the phone's call transport reads and writes
 * itself (packages/wire/src/audio.ts is the source of truth for their shape).
 * Everything else on the socket is passed to JS untouched.
 */
object CallFrames {
  const val HEARTBEAT = "audio.heartbeat"
  const val BARGE_IN = "audio.barge_in"

  /** The frame's `type`, or null for a frame that is not a JSON object with one. */
  fun typeOf(text: String): String? =
    try {
      JSONObject(text).optString("type").ifEmpty { null }
    } catch (_: JSONException) {
      null
    }

  /**
   * The echo of a host heartbeat (wire `heartbeatEcho`: type, sessionId, n), or
   * null when `text` is not one. Answered on the socket's own thread the moment
   * it arrives: the host judges the device by it (spec/07 § Fixed timings).
   */
  fun heartbeatEcho(text: String): String? {
    val frame =
      try {
        JSONObject(text)
      } catch (_: JSONException) {
        return null
      }
    if (frame.optString("type") != HEARTBEAT) return null
    if (!frame.has("sessionId") || !frame.has("n")) return null
    return JSONObject()
      .put("type", HEARTBEAT)
      .put("sessionId", frame.getString("sessionId"))
      .put("n", frame.getLong("n"))
      .toString()
  }

  /** The `audio.pcm16` header that precedes each binary mic frame. */
  fun micHeader(ts: Long, samples: Int): String =
    JSONObject()
      .put("type", "audio.pcm16")
      .put("ts", ts)
      .put("sampleRate", MicCapture.SAMPLE_RATE)
      .put("samples", samples)
      .toString()
}
