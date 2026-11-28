package dev.patchhq.app

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.exp

/**
 * Smart Turn's input features on the phone (spec/07 § Direct calls → end of
 * turn on the device): the same Whisper log-mel features as
 * `@patch/wire/smart-turn` (`whisperFeatures`), a port of transformers'
 * WhisperFeatureExtractor (do_normalize=True) for exactly 8 s of 16 kHz audio,
 * as [80, 800] row-major. Checked against the same reference values in
 * SmartTurnFeaturesTest.
 */
object SmartTurnFeatures {
  const val SAMPLE_RATE = 16000
  const val N_SAMPLES = 8 * SAMPLE_RATE
  const val N_FFT = 400
  const val HOP = 160
  const val N_MELS = 80
  const val N_BINS = N_FFT / 2 + 1
  const val N_FRAMES = N_SAMPLES / HOP

  /** The last 8 s of `pcm` as floats in [-1, 1], zero-padded at the front. */
  fun lastEightSeconds(pcm: ShortArray): DoubleArray {
    val out = DoubleArray(N_SAMPLES)
    val take = min(pcm.size, N_SAMPLES)
    val from = pcm.size - take
    val at = N_SAMPLES - take
    for (i in 0 until take) out[at + i] = pcm[from + i] / 32768.0
    return out
  }

  private fun hzToMel(f: Double): Double =
    if (f < 1000) (3 * f) / 200 else 15 + (ln(f / 1000) * 27) / ln(6.4)

  private fun melToHz(m: Double): Double =
    if (m < 15) (200 * m) / 3 else 1000 * exp((ln(6.4) * (m - 15)) / 27)

  /**
   * Radices of the mixed-radix FFT (Stockham autosort): 5·5·2·2·2·2 = 400. The
   * same numbers as the plain DFT in about a tenth of the work, as in
   * `@patch/wire/smart-turn` (`powerSpectrum`).
   */
  private val RADICES = intArrayOf(5, 5, 2, 2, 2, 2)

  private val tables by lazy {
    val wRe = DoubleArray(N_FFT) { e -> cos((2 * PI * e) / N_FFT) }
    val wIm = DoubleArray(N_FFT) { e -> -sin((2 * PI * e) / N_FFT) }
    val window = DoubleArray(N_FFT) { n -> 0.5 - 0.5 * cos((2 * PI * n) / N_FFT) }
    val maxHz = SAMPLE_RATE / 2.0
    val melMax = hzToMel(maxHz)
    val edges = DoubleArray(N_MELS + 2) { i -> melToHz((melMax * i) / (N_MELS + 1)) }
    val rows =
      Array(N_MELS) { m ->
        val lo = edges[m]
        val mid = edges[m + 1]
        val hi = edges[m + 2]
        val enorm = 2 / (hi - lo)
        DoubleArray(N_BINS) { k ->
          val f = (maxHz * k) / (N_BINS - 1)
          val down = (f - lo) / (mid - lo)
          val up = (hi - f) / (hi - mid)
          max(0.0, min(down, up)) * enorm
        }
      }
    // Each filter over its non-zero bins only.
    val melFrom = IntArray(N_MELS)
    val mel =
      Array(N_MELS) { m ->
        val row = rows[m]
        var from = 0
        while (from < N_BINS && row[from] == 0.0) from++
        var to = N_BINS
        while (to > from && row[to - 1] == 0.0) to--
        melFrom[m] = from
        row.copyOfRange(from, to)
      }
    Tables(wRe, wIm, window, mel, melFrom)
  }

  private class Tables(
    val wRe: DoubleArray,
    val wIm: DoubleArray,
    val window: DoubleArray,
    val mel: Array<DoubleArray>,
    val melFrom: IntArray,
  )

  /** `power[k] = |X[k]|²` for k in [0, N_BINS) of the real 400-sample `frame`. */
  fun powerSpectrum(frame: DoubleArray, power: DoubleArray) {
    val t = tables
    var xRe = frame.copyOf()
    var xIm = DoubleArray(N_FFT)
    var yRe = DoubleArray(N_FFT)
    var yIm = DoubleArray(N_FFT)
    val vRe = DoubleArray(5)
    val vIm = DoubleArray(5)
    var ns = 1
    for (r in RADICES) {
      val stride = N_FFT / r
      val step = N_FFT / (ns * r)
      for (j in 0 until stride) {
        val k = j % ns
        for (a in 0 until r) {
          val re = xRe[j + a * stride]
          val im = xIm[j + a * stride]
          val e = (k * a * step) % N_FFT
          vRe[a] = re * t.wRe[e] - im * t.wIm[e]
          vIm[a] = re * t.wIm[e] + im * t.wRe[e]
        }
        val out = (j / ns) * ns * r + k
        for (q in 0 until r) {
          var sRe = 0.0
          var sIm = 0.0
          for (a in 0 until r) {
            val e = ((a * q) % r) * stride
            sRe += vRe[a] * t.wRe[e] - vIm[a] * t.wIm[e]
            sIm += vRe[a] * t.wIm[e] + vIm[a] * t.wRe[e]
          }
          yRe[out + q * ns] = sRe
          yIm[out + q * ns] = sIm
        }
      }
      val sr = xRe
      xRe = yRe
      yRe = sr
      val si = xIm
      xIm = yIm
      yIm = si
      ns *= r
    }
    for (k in 0 until N_BINS) power[k] = xRe[k] * xRe[k] + xIm[k] * xIm[k]
  }

  fun whisperFeatures(audio: DoubleArray): FloatArray {
    require(audio.size == N_SAMPLES) { "expected $N_SAMPLES samples, got ${audio.size}" }
    val t = tables
    var mean = 0.0
    for (v in audio) mean += v
    mean /= audio.size
    var variance = 0.0
    for (v in audio) variance += (v - mean) * (v - mean)
    variance /= audio.size
    val scale = 1 / sqrt(variance + 1e-7)

    val pad = N_FFT / 2
    val padded = DoubleArray(audio.size + 2 * pad)
    for (i in audio.indices) padded[pad + i] = (audio[i] - mean) * scale
    for (i in 0 until pad) {
      padded[pad - 1 - i] = padded[pad + 1 + i]
      padded[pad + audio.size + i] = padded[pad + audio.size - 2 - i]
    }

    val out = DoubleArray(N_MELS * N_FRAMES)
    val frame = DoubleArray(N_FFT)
    val power = DoubleArray(N_BINS)
    var top = Double.NEGATIVE_INFINITY
    for (fr in 0 until N_FRAMES) {
      val start = fr * HOP
      for (n in 0 until N_FFT) frame[n] = padded[start + n] * t.window[n]
      powerSpectrum(frame, power)
      for (m in 0 until N_MELS) {
        val filter = t.mel[m]
        val from = t.melFrom[m]
        var e = 0.0
        for (k in filter.indices) e += filter[k] * power[from + k]
        val v = log10(max(e, 1e-10))
        out[m * N_FRAMES + fr] = v
        if (v > top) top = v
      }
    }
    return FloatArray(out.size) { i -> ((max(out[i], top - 8) + 4) / 4).toFloat() }
  }
}
