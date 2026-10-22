package com.frontierwire.core

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** Notification channels, so people can mute one kind in system settings. */
object Notify {
    data class Channel(val id: String, val name: String, val description: String, val importance: Int)

    fun ensureChannels(context: Context, channels: List<Channel>) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java)
        for (c in channels) nm.createNotificationChannel(NotificationChannel(c.id, c.name, c.importance).apply { description = c.description })
    }

    fun allowed(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Shows one notification that opens [intent]; [tag] replaces an earlier one about the same thing. */
    fun show(context: Context, channel: String, tag: String, title: String, body: String, icon: Int, intent: Intent) {
        if (!allowed(context)) return
        val pi = PendingIntent.getActivity(context, tag.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(context, channel)
            .setSmallIcon(icon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setPriority(if (channel == "breaking") NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(tag, 0, n) }
    }
}
