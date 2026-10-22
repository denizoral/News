package com.frontierwire.app

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.frontierwire.core.Notify
import com.frontierwire.core.json
import java.util.concurrent.TimeUnit

/**
 * The fallback when Firebase isn't set up (or the server says push is off):
 * every 15 minutes or so, Android lets the app check for breaking news and
 * for new stories about what the reader follows, and notifies locally.
 * Same rules as the server: enough outlets, quiet hours, one per story.
 */
class CheckWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val session = Session.get(applicationContext)
        val cfg = runCatching { session.api.getAs<ServerConfig>("/api/user/config") }.getOrNull() ?: return Result.retry()
        if (cfg.push && Devices.firebase) return Result.success() // the server pushes instead
        val prefs = session.prefs.value
        val a = prefs.alerts
        if (a.quiet != null) {
            val h = java.time.ZonedDateTime.now().hour
            val q = a.quiet
            if (if (q.from <= q.to) h in q.from until q.to else h >= q.from || h < q.to) return Result.success()
        }
        val snap = runCatching { json.decodeFromJsonElement(Snapshot.serializer(), session.api.get("/api/snapshot")) }.getOrNull() ?: return Result.retry()
        val ctx = applicationContext
        if (a.breaking) {
            for (b in snap.breaking.filter { !Seen.has(ctx, it.sid) }.take(1)) {
                Notify.show(ctx, "breaking", "story-${b.sid}", "Breaking", b.title, R.drawable.ic_stat, storyIntent(ctx, b.sid, null))
                Seen.add(ctx, b.sid)
            }
        }
        if (a.follows && prefs.follows.count > 0) {
            val since = System.currentTimeMillis() - 6 * 3600_000
            val pick = snap.stories
                .filter { it.publishedAt > since && it.outlets >= a.minOutlets && !Seen.has(ctx, it.sid) }
                .mapNotNull { s -> prefs.follows.match(s)?.let { s to it } }
                .maxByOrNull { it.first.outlets }
            pick?.let { (s, why) ->
                Notify.show(ctx, "follows", "story-${s.sid}", why, s.title, R.drawable.ic_stat, storyIntent(ctx, s.sid, null))
                Seen.add(ctx, s.sid)
            }
        }
        return Result.success()
    }

    companion object {
        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<CheckWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("check", ExistingPeriodicWorkPolicy.KEEP, req)
        }
    }
}
