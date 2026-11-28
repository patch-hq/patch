package dev.patchhq.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The frames the call transport answers and writes on its own native thread
 * (packages/wire/src/audio.ts is the source of truth for their shape).
 */
class CallFramesTest {
  @Test
  fun heartbeatIsEchoedWithItsSessionAndNumberOnly() {
    val echo =
      CallFrames.heartbeatEcho(
        """{"type":"audio.heartbeat","sessionId":"s1","n":41,"rttMs":87}"""
      )
    val frame = JSONObject(echo!!)
    assertEquals("audio.heartbeat", frame.getString("type"))
    assertEquals("s1", frame.getString("sessionId"))
    assertEquals(41L, frame.getLong("n"))
    // wire heartbeatEcho carries type, sessionId and n — nothing else.
    assertEquals(3, frame.length())
  }

  @Test
  fun otherFramesAreNotEchoed() {
    assertNull(CallFrames.heartbeatEcho("""{"type":"audio.state","state":"listening"}"""))
    assertNull(CallFrames.heartbeatEcho("""{"type":"audio.heartbeat","n":1}"""))
    assertNull(CallFrames.heartbeatEcho("not json"))
  }

  @Test
  fun typeOfReadsTheFrameType() {
    assertEquals("audio.barge_in", CallFrames.typeOf("""{"type":"audio.barge_in"}"""))
    assertNull(CallFrames.typeOf("""{"state":"listening"}"""))
    assertNull(CallFrames.typeOf("[1,2]"))
  }

  @Test
  fun micHeaderDescribesTheFrameThatFollows() {
    val header = JSONObject(CallFrames.micHeader(1234L, MicCapture.FRAME_SAMPLES))
    assertEquals("audio.pcm16", header.getString("type"))
    assertEquals(1234L, header.getLong("ts"))
    assertEquals(16000, header.getInt("sampleRate"))
    assertEquals(640, header.getInt("samples"))
  }
}
