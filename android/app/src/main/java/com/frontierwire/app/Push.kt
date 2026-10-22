package com.frontierwire.app

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.frontierwire.core.Notify
import com.frontierwire.core.json
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.decodeFromString

val CHANNELS = listOf(
    Notify.Channel("breaking", "Breaking news", "A story many outlets are suddenly covering", NotificationManager.IMPORTANCE_HIGH),
    Notify.Channel("follows", "Things you follow", "Stories about the topics, names, accounts and outlets you follow", NotificationManager.IMPORTANCE_DEFAULT),
    Notify.Channel("news", "Other news", "Everything else", NotificationManager.IMPORTANCE_LOW),
)

private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

/** Opens a story in the app (the story page on the site). */
fun storyIntent(context: Context, sid: String?, url: String?): Intent =
    Intent(context, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        sid?.let { putExtra("sid", it) }
        url?.let { data = Uri.parse(it) }
    }

object Devices {
    /** Tells the server where to push. Without Firebase this quietly does nothing. */
    fun register(context: Context) {
        scope.launch {
            val token = runCatching { FirebaseMessaging.getInstance().token.await() }.getOrNull() ?: return@launch
            runCatching { Session.get(context).api.post("/api/devices", mapOf("token" to token, "platform" to "android")) }
        }
    }

    val firebase: Boolean
        get() = runCatching { com.google.firebase.FirebaseApp.getInstance() }.isSuccess
}

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        scope.launch { runCatching { Session.get(this@PushService).api.post("/api/devices", mapOf("token" to token, "platform" to "android")) } }
    }

    override fun onMessageReceived(msg: RemoteMessage) {
        val n = msg.notification ?: return
        val channel = n.channelId ?: "news"
        val sid = msg.data["sid"]
        Notify.show(this, channel, "story-${sid ?: msg.messageId}", n.title ?: "Frontier Wire", n.body ?: "", R.drawable.ic_stat, storyIntent(this, sid, null))
        Seen.add(this, sid)
    }
}

/** Stories the phone already notified about, so the fallback check doesn't repeat them. */
object Seen {
    fun add(context: Context, sid: String?) {
        if (sid == null) return
        val p = context.getSharedPreferences("seen", Context.MODE_PRIVATE)
        val list = (p.getString("sids", "") ?: "").split(',').filter { it.isNotBlank() }.takeLast(300) + sid
        p.edit().putString("sids", list.joinToString(",")).apply()
    }

    fun has(context: Context, sid: String) = (context.getSharedPreferences("seen", Context.MODE_PRIVATE).getString("sids", "") ?: "").split(',').contains(sid)
}
