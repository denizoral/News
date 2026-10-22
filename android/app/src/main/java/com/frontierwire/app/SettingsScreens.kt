package com.frontierwire.app

import android.content.Context
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.InputChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import com.frontierwire.core.LocalWire
import com.frontierwire.core.Notify
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.launch

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), border = BorderStroke(1.dp, LocalWire.current.line), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            content()
        }
    }
}

@Composable
private fun SwitchRow(title: String, sub: String, on: Boolean, change: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(sub, style = MaterialTheme.typography.bodySmall, color = LocalWire.current.muted)
        }
        Switch(checked = on, onCheckedChange = change)
    }
}

@Composable
private fun <T> Choice(label: String, options: List<Pair<T, String>>, value: T, change: (T) -> Unit) {
    Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 10.dp, bottom = 6.dp))
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        options.forEachIndexed { i, (v, l) ->
            SegmentedButton(selected = v == value, onClick = { change(v) }, shape = SegmentedButtonDefaults.itemShape(i, options.size)) { Text(l) }
        }
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun AlertsScreen(session: Session, askNotifications: () -> Unit) {
    val prefs by session.prefs.collectAsState()
    val user by session.user.collectAsState()
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var error by remember { mutableStateOf<String?>(null) }
    var cfg by remember { mutableStateOf<ServerConfig?>(null) }
    LaunchedEffect(Unit) { cfg = runCatching { session.api.getAs<ServerConfig>("/api/user/config") }.getOrNull() }
    val a = prefs.alerts
    fun save(next: Alerts) = scope.launch { runCatching { session.setPrefs(prefs.copy(alerts = next)) }.onFailure { error = it.message } }

    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Header("Alerts", if (cfg?.push == true && Devices.firebase) "Pushed the moment it happens" else "Checked about every 15 minutes")
        if (!Notify.allowed(ctx)) {
            Section("Notifications are off") {
                Text("Allow notifications so the app can tell you when something breaks.", style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(8.dp))
                Button(onClick = askNotifications) { Text("Allow notifications") }
            }
        }
        Section("What to send") {
            SwitchRow("Breaking news", "When many outlets suddenly cover one story", a.breaking) { save(a.copy(breaking = it)) }
            HorizontalDivider()
            SwitchRow("Things you follow", if (user == null && cfg?.push == true) "Sign in so the server can match your follows" else "New stories about your follows", a.follows) { save(a.copy(follows = it)) }
            Choice("Only when this many outlets carry it", listOf(1 to "1", 2 to "2", 3 to "3", 5 to "5", 8 to "8"), a.minOutlets) { save(a.copy(minOutlets = it)) }
            Choice("At most per day", listOf(3 to "3", 6 to "6", 12 to "12", 24 to "24", 48 to "48"), a.maxPerDay) { save(a.copy(maxPerDay = it)) }
        }
        Section("Quiet hours") {
            val tz = java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60000
            SwitchRow("Pause overnight", a.quiet?.let { "From ${it.from}:00 to ${it.to}:00" } ?: "Breaking news too", a.quiet != null) {
                save(a.copy(quiet = if (it) Quiet(22, 7, tz) else null))
            }
            a.quiet?.let { q ->
                Choice("Starting", listOf(21 to "21:00", 22 to "22:00", 23 to "23:00", 0 to "0:00"), q.from) { save(a.copy(quiet = q.copy(from = it, tz = tz))) }
                Choice("Until", listOf(6 to "6:00", 7 to "7:00", 8 to "8:00", 9 to "9:00"), q.to) { save(a.copy(quiet = q.copy(to = it, tz = tz))) }
            }
        }
        Section("You follow") {
            if (prefs.follows.count == 0) Text("Nothing yet. Tap ⋮ on a story to follow who and what it’s about.", color = LocalWire.current.muted, style = MaterialTheme.typography.bodyMedium)
            for ((kind, title) in listOf("names" to "Names", "topics" to "Topics", "accounts" to "X accounts", "outlets" to "Outlets")) {
                val list = prefs.follows.list(kind)
                if (list.isEmpty()) continue
                Text(title, style = MaterialTheme.typography.labelSmall, color = LocalWire.current.muted, modifier = Modifier.padding(top = 8.dp, bottom = 4.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (f in list) InputChip(selected = true, onClick = { scope.launch { runCatching { session.toggleFollow(kind, f.key, f.label) } } }, label = { Text(f.label) }, trailingIcon = { Icon(Icons.Filled.Close, contentDescription = "Unfollow ${f.label}") })
                }
            }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

@Composable
fun AccountScreen(session: Session) {
    val user by session.user.collectAsState()
    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (user == null) SignIn(session) else SignedIn(session, user!!)
    }
}

@Composable
private fun SignIn(session: Session) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var creating by remember { mutableStateOf(false) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var cfg by remember { mutableStateOf<ServerConfig?>(null) }
    LaunchedEffect(Unit) { cfg = runCatching { session.api.getAs<ServerConfig>("/api/user/config") }.getOrNull() }

    Header(if (creating) "Create an account" else "Sign in", "Your follows and alerts, on every device")
    if (creating) OutlinedTextField(name, { name = it }, label = { Text("Name (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
    OutlinedTextField(email, { email = it.trim() }, label = { Text("Email") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth())
    OutlinedTextField(
        password, { password = it }, label = { Text("Password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        supportingText = if (creating) ({ Text("At least ${cfg?.passwordMin ?: 12} characters. A few words work well.") }) else null,
        modifier = Modifier.fillMaxWidth(),
    )
    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
    Button(
        enabled = !busy && email.isNotBlank() && password.isNotBlank(),
        onClick = {
            busy = true
            error = null
            scope.launch {
                runCatching { if (creating) session.signUp(email, password, name) else session.signIn(email, password) }.onFailure { error = it.message }
                busy = false
            }
        },
        modifier = Modifier.fillMaxWidth(),
    ) { Text(if (creating) "Create account" else "Sign in") }
    TextButton(onClick = { creating = !creating; error = null }, modifier = Modifier.fillMaxWidth()) { Text(if (creating) "I have an account" else "Create an account") }
    val clientId = cfg?.googleClientId?.takeIf { it.isNotBlank() } ?: BuildConfig.GOOGLE_CLIENT_ID.takeIf { it.isNotBlank() }
    if (cfg?.google == true && clientId != null) {
        HorizontalDivider(Modifier.padding(vertical = 4.dp))
        OutlinedButton(
            enabled = !busy,
            onClick = {
                busy = true
                error = null
                scope.launch {
                    runCatching { session.signInWithGoogle(googleIdToken(ctx, clientId)) }.onFailure { error = it.message ?: "Google sign-in didn’t finish." }
                    busy = false
                }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Continue with Google") }
    }
}

private suspend fun googleIdToken(ctx: Context, clientId: String): String {
    val req = GetCredentialRequest.Builder().addCredentialOption(GetSignInWithGoogleOption.Builder(clientId).build()).build()
    val cred = CredentialManager.create(ctx).getCredential(ctx, req).credential
    if (cred is CustomCredential && cred.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) return GoogleIdTokenCredential.createFrom(cred.data).idToken
    error("Google sign-in didn’t return an account.")
}

@Composable
private fun SignedIn(session: Session, user: User) {
    val scope = rememberCoroutineScope()
    var confirmDelete by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    Header(user.name.ifBlank { "Your account" }, user.email)
    Section("Signed in") {
        Text(listOfNotNull(if (user.hasPassword) "Email and password" else null, if (user.google) "Google" else null).joinToString(" · "), color = LocalWire.current.muted)
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = { scope.launch { session.signOut() } }) { Text("Sign out") }
    }
    Section("Delete account") {
        Text("Removes your account, follows and alert settings from the server.", style = MaterialTheme.typography.bodyMedium, color = LocalWire.current.muted)
        Spacer(Modifier.height(8.dp))
        TextButton(onClick = { confirmDelete = true }) { Text("Delete my account", color = MaterialTheme.colorScheme.error) }
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete your account?") },
            text = {
                Column {
                    Text("This can’t be undone.")
                    if (user.hasPassword) OutlinedTextField(password, { password = it }, label = { Text("Password") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            },
            confirmButton = { TextButton(onClick = { scope.launch { runCatching { session.deleteAccount(password) }.onSuccess { confirmDelete = false }.onFailure { error = it.message } } }) { Text("Delete", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
}
