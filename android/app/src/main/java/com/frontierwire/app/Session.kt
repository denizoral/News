package com.frontierwire.app

import android.content.Context
import com.frontierwire.core.Api
import com.frontierwire.core.SecureStore
import com.frontierwire.core.json
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.encodeToString

/**
 * Who's signed in, and their follows and alert settings. Signed out, follows
 * live on the phone; signing in merges them into the account, and from then
 * on the server holds them (it needs them to send follow alerts).
 */
class Session(private val context: Context) {
    private val secrets = SecureStore(context, "session")
    private val local = context.getSharedPreferences("wire", Context.MODE_PRIVATE)

    val api = Api(client = "wire-app", token = { secrets.get("token") })

    private val _user = MutableStateFlow<User?>(null)
    val user: StateFlow<User?> = _user.asStateFlow()

    private val _prefs = MutableStateFlow(readLocal())
    val prefs: StateFlow<Prefs> = _prefs.asStateFlow()

    val signedIn get() = secrets.get("token") != null

    private fun readLocal(): Prefs = runCatching { json.decodeFromString<Prefs>(local.getString("prefs", null)!!) }.getOrDefault(Prefs())
    private fun writeLocal(p: Prefs) = local.edit().putString("prefs", json.encodeToString(p)).apply()

    /** Refreshes the account from the server; a dead session signs out. */
    suspend fun refresh() {
        if (!signedIn) return
        runCatching { api.getAs<Map<String, User>>("/api/user")["user"] }
            .onSuccess { u ->
                _user.value = u
                if (u != null) setPrefs(u.prefs, push = false)
            }
            .onFailure { if ((it as? com.frontierwire.core.ApiError)?.status == 401) signOutLocally() }
    }

    suspend fun signUp(email: String, password: String, name: String) = finish(api.postAs<AuthResult>("/api/user/signup", mapOf("email" to email, "password" to password, "name" to name)))
    suspend fun signIn(email: String, password: String) = finish(api.postAs<AuthResult>("/api/user/login", mapOf("email" to email, "password" to password)))
    suspend fun signInWithGoogle(idToken: String) = finish(api.postAs<AuthResult>("/api/user/google", mapOf("idToken" to idToken)))

    private suspend fun finish(r: AuthResult) {
        secrets.put("token", r.token)
        // Follows made before signing in join the account's.
        val merged = r.user.prefs.copy(follows = r.user.prefs.follows.merge(_prefs.value.follows))
        _user.value = r.user
        setPrefs(merged, push = merged != r.user.prefs)
        Devices.register(context)
    }

    suspend fun setPrefs(p: Prefs, push: Boolean = true) {
        _prefs.value = p
        writeLocal(p)
        if (push && signedIn) {
            val body = json.encodeToJsonElement(Prefs.serializer(), p)
            api.put("/api/user/prefs", body)
        }
    }

    suspend fun toggleFollow(kind: String, key: String, label: String) {
        val p = _prefs.value
        setPrefs(p.copy(follows = p.follows.toggle(kind, key, label)))
    }

    suspend fun signOut() {
        runCatching { api.post("/api/user/logout") }
        signOutLocally()
        Devices.register(context) // stays registered for breaking news, anonymously
    }

    suspend fun deleteAccount(password: String) {
        api.post("/api/user/delete", mapOf("password" to password))
        signOutLocally()
    }

    private fun signOutLocally() {
        secrets.put("token", null)
        _user.value = null
    }

    companion object {
        @Volatile private var instance: Session? = null
        fun get(context: Context) = instance ?: synchronized(this) { instance ?: Session(context.applicationContext).also { instance = it } }
    }
}
