package dev.patchhq.app

import kotlin.math.PI
import kotlin.math.roundToInt
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The phone's Smart Turn features must be the host's (packages/host/test/
 * smart-turn.test.ts), whose reference values came from transformers'
 * WhisperFeatureExtractor on the same chirp — or the model scores a different
 * signal from the one it was trained on.
 */
class SmartTurnFeaturesTest {
  private fun chirp(): ShortArray {
    val n = 3 * 16000
    return ShortArray(n) { i ->
      val t = i / 16000.0
      val x = 0.3 * sin(2 * PI * (220 + 200 * t) * t) + 0.05 * sin(2 * PI * 1500 * t)
      (x.toFloat() * 32768).roundToInt().coerceIn(-32768, 32767).toShort()
    }
  }

  @Test
  fun matchesWhisperFeatureExtractorOnTheReferenceChirp() {
    val f = SmartTurnFeatures.whisperFeatures(SmartTurnFeatures.lastEightSeconds(chirp()))
    assertEquals(80 * SmartTurnFeatures.N_FRAMES, f.size)
    val reference =
      listOf(
        Triple(0, 0, -0.21808099746704102),
        Triple(0, 799, 0.5407990217208862),
        Triple(20, 750, -0.032506346702575684),
        Triple(40, 600, 0.08442544937133789),
        Triple(79, 799, 0.006798207759857178),
        Triple(30, 780, 0.6598823666572571),
        Triple(60, 790, -0.21808099746704102),
      )
    for ((mel, frame, want) in reference) {
      assertEquals(want, f[mel * SmartTurnFeatures.N_FRAMES + frame].toDouble(), 1e-4)
    }
    assertEquals(-0.10897202044725418, f.map { it.toDouble() }.average(), 1e-4)
  }

  @Test
  fun theFftGivesThePlainDft() {
    var seed = 7L
    val frames =
      listOf(
        DoubleArray(400) { i -> sin((2 * PI * 37 * i) / 400) },
        DoubleArray(400) {
          seed = (seed * 16807) % 2147483647
          (seed / 2147483647.0) * 2 - 1
        },
        DoubleArray(400) { i -> if (i == 0) 1.0 else 0.0 },
      )
    for (frame in frames) {
      val got = DoubleArray(201)
      SmartTurnFeatures.powerSpectrum(frame, got)
      for (k in 0 until 201) {
        var re = 0.0
        var im = 0.0
        for (t in 0 until 400) {
          re += frame[t] * kotlin.math.cos((2 * PI * k * t) / 400)
          im -= frame[t] * sin((2 * PI * k * t) / 400)
        }
        assertEquals(re * re + im * im, got[k], 1e-6)
      }
    }
  }

  @Test
  fun keepsTheLastEightSecondsPaddingAShortClipAtTheFront() {
    val short = ShortArray(16000) { 1000 }
    val padded = SmartTurnFeatures.lastEightSeconds(short)
    assertEquals(0.0, padded[0], 0.0)
    assertEquals(1000 / 32768.0, padded[127998], 1e-9)
    val long = ShortArray(10 * 16000) { i -> if (i == 10 * 16000 - 1) 32767 else 0 }
    assertEquals(32767 / 32768.0, SmartTurnFeatures.lastEightSeconds(long)[127999], 1e-9)
  }
}
