package io.github.tomchambers2.patch

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

/**
 * Makes a native crash's stack retrievable on the next launch.
 *
 * {@link install} (called from MainApplication.onCreate — see
 * plugins/withCrashCapture.js) sets a default uncaught-exception handler that
 * writes the throwable's stack to a file before handing the crash on to the
 * previous handler (so the process still dies as it did). Crashes that skip the
 * JVM handler — native signals, ANRs — leave no file, so on the next launch
 * {@link takeLastCrash} also asks Android's ApplicationExitInfo (API 30+) for
 * the previous process's exit and, for a native crash or ANR, returns its trace.
 *
 * JS reads it once via takeLastCrash() (src/lib/crashReport.ts), which returns
 * and clears it.
 */
class PatchCrashModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  companion object {
    private const val FILE = "last-native-crash.txt"
    private const val PREFS = "patch-crash"
    private const val PREF_LAST_EXIT = "lastExitTimestamp"

    fun install(context: Context) {
      val previous = Thread.getDefaultUncaughtExceptionHandler()
      Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
        try {
          val sw = StringWriter()
          throwable.printStackTrace(PrintWriter(sw))
          File(context.filesDir, FILE).writeText(
            "${System.currentTimeMillis()}\n${throwable.javaClass.name}: ${throwable.message}\n" +
              "thread: ${thread.name}\n${sw}",
          )
        } catch (_: Throwable) {
          // Never let the recorder mask the original crash.
        }
        previous?.uncaughtException(thread, throwable)
      }
    }
  }

  override fun getName(): String = "PatchCrash"

  @ReactMethod
  fun takeLastCrash(promise: Promise) {
    try {
      val file = File(ctx.filesDir, FILE)
      if (file.exists()) {
        val lines = file.readText().split("\n", limit = 3)
        file.delete()
        val map = Arguments.createMap()
        map.putDouble("occurredAt", lines[0].toDouble())
        map.putString("message", lines.getOrElse(1) { "" })
        map.putString("stack", lines.getOrElse(2) { "" })
        promise.resolve(map)
        return
      }
      promise.resolve(lastProcessExit())
    } catch (e: Throwable) {
      promise.reject("E_CRASH_READ", e)
    }
  }

  private fun lastProcessExit() = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) null else {
    val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val seen = prefs.getLong(PREF_LAST_EXIT, 0L)
    val exit = am.getHistoricalProcessExitReasons(ctx.packageName, 0, 5)
      .firstOrNull { it.timestamp > seen }
    if (exit == null) null else {
      prefs.edit().putLong(PREF_LAST_EXIT, exit.timestamp).apply()
      val reportable = exit.reason == ApplicationExitInfo.REASON_CRASH_NATIVE ||
        exit.reason == ApplicationExitInfo.REASON_ANR
      if (!reportable) null else {
        val trace = exit.traceInputStream?.bufferedReader()?.use { it.readText() } ?: ""
        val map = Arguments.createMap()
        map.putDouble("occurredAt", exit.timestamp.toDouble())
        map.putString("message", "previous process exit: ${exit.description ?: exit.reason}")
        map.putString("stack", trace.take(30000))
        map
      }
    }
  }
}
