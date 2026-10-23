package com.frontierwire.admin

import android.app.Application
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import com.frontierwire.core.Api
import com.frontierwire.core.ApiError
import com.frontierwire.core.Notify
import com.frontierwire.core.SecureStore
import com.frontierwire.core.str
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * The admin's session: the same accounts, passwords and two-factor codes as
 * the web dashboard. The server hands the app a bearer token (no cookie);
 * it's kept encrypted with a Keystore key. Sessions expire like the
 * dashboard's (idle 30 minutes, 12 hours at most), then it's sign in again.
 */
class AdminSession(private val context: Context) {
    private val secrets = SecureStore(context, "admin")
    val api = Api(client = "wire-admin-app", token = { secrets.get("token") })

    enum class Stage { SignedOut, NeedsCode, SignedIn }
    val stage = MutableStateFlow(if (secrets.get("token") != null) Stage.SignedIn else Stage.SignedOut)
    val username = MutableStateFlow(secrets.get("user"))

    suspend fun login(user: String, password: String) {
        val r = api.post("/api/admin/login", mapOf("username" to user, "password" to password))
        secrets.put("token", r.str("token"))
        secrets.put("user", user)
        username.value = user
        when (r.str("next")) {
            "mfa" -> stage.value = Stage.NeedsCode
            "enroll" -> throw ApiError(403, "Set up two-factor sign-in on the web dashboard first, then sign in here.")
            "password" -> throw ApiError(403, "Choose a new password on the web dashboard first.")
            else -> signedIn()
        }
    }

    suspend fun code(code: String, recovery: Boolean) {
        val r = api.post("/api/admin/login/mfa", if (recovery) mapOf("recoveryCode" to code) else mapOf("code" to code))
        secrets.put("token", r.str("token"))
        signedIn()
    }

    private fun signedIn() {
        stage.value = Stage.SignedIn
        registerDevice()
    }

    fun registerDevice() {
        CoroutineScope(Dispatchers.IO).launch {
            val t = runCatching { FirebaseMessaging.getInstance().token.await() }.getOrNull() ?: return@launch
            runCatching { api.post("/api/admin/devices", mapOf("token" to t, "platform" to "android")) }
        }
    }

    suspend fun logout() {
        runCatching { FirebaseMessaging.getInstance().token.await() }.getOrNull()?.let { t -> runCatching { api.post("/api/admin/devices/remove", mapOf("token" to t)) } }
        runCatching { api.post("/api/admin/logout") }
        expired()
    }

    /** Any 401 lands here: back to the sign-in screen. */
    fun expired() {
        secrets.put("token", null)
        stage.value = Stage.SignedOut
    }

    /** Runs a call; a lapsed session signs out instead of showing an error. */
    suspend fun <T> call(block: suspend Api.() -> T): Result<T> = runCatching { api.block() }.onFailure { if ((it as? ApiError)?.status == 401) expired() }

    companion object {
        @Volatile private var instance: AdminSession? = null
        fun get(context: Context) = instance ?: synchronized(this) { instance ?: AdminSession(context.applicationContext).also { instance = it } }
    }
}

val ADMIN_CHANNELS = listOf(
    Notify.Channel("changelog", "New features", "Each feature shipped to the site", NotificationManager.IMPORTANCE_DEFAULT),
    Notify.Channel("health", "Source health", "A source stops working or recovers", NotificationManager.IMPORTANCE_HIGH),
)

class AdminApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notify.ensureChannels(this, ADMIN_CHANNELS)
        if (AdminSession.get(this).stage.value == AdminSession.Stage.SignedIn) AdminSession.get(this).registerDevice()
    }
}

class PushService : FirebaseMessagingService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNewToken(token: String) {
        val s = AdminSession.get(this)
        if (s.stage.value == AdminSession.Stage.SignedIn) scope.launch { s.call { post("/api/admin/devices", mapOf("token" to token, "platform" to "android")) } }
    }

    override fun onMessageReceived(msg: RemoteMessage) {
        val n = msg.notification ?: return
        val tab = if (msg.data["kind"] == "feature") "changelog" else "sources"
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("tab", tab)
        }
        Notify.show(this, n.channelId ?: "changelog", "${msg.data["kind"]}-${msg.data["id"] ?: msg.data["name"] ?: msg.messageId}", n.title ?: "Wire Admin", n.body ?: "", R.drawable.ic_stat, intent)
    }
}
