package com.frontierwire.admin

import android.Manifest
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Article
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.NewReleases
import androidx.compose.material.icons.outlined.RssFeed
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.frontierwire.core.LocalWire
import com.frontierwire.core.Notify
import com.frontierwire.core.WireTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val ask = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= 33 && !Notify.allowed(this)) ask.launch(Manifest.permission.POST_NOTIFICATIONS)
        val start = intent?.getStringExtra("tab") ?: "overview"
        val session = AdminSession.get(this)
        setContent {
            WireTheme {
                val stage by session.stage.collectAsState()
                if (stage == AdminSession.Stage.SignedIn) Panel(session, start, ::openSite) else SignIn(session, stage)
            }
        }
    }

    fun openSite(path: String) {
        val url = AdminSession.get(this).api.baseUrl + path
        runCatching { CustomTabsIntent.Builder().build().launchUrl(this, Uri.parse(url)) }
    }
}

@Composable
private fun SignIn(session: AdminSession, stage: AdminSession.Stage) {
    val scope = rememberCoroutineScope()
    var user by rememberSaveable { mutableStateOf(session.username.value ?: "") }
    var pass by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var recovery by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun go(block: suspend () -> Unit) {
        busy = true
        error = null
        scope.launch {
            runCatching { block() }.onFailure { error = it.message }
            busy = false
        }
    }
    Scaffold { pad ->
        Column(Modifier.fillMaxSize().padding(pad).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Spacer(Modifier.height(32.dp))
            Text("WIRE ADMIN", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
            if (stage == AdminSession.Stage.NeedsCode) {
                Text(if (recovery) "Recovery code" else "Two-factor code", style = MaterialTheme.typography.headlineMedium)
                Text(if (recovery) "One of the codes you saved when you set up two-factor sign-in." else "The 6-digit code from your authenticator app.", color = LocalWire.current.muted)
                OutlinedTextField(code, { code = it.trim() }, label = { Text("Code") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = if (recovery) KeyboardType.Text else KeyboardType.NumberPassword), modifier = Modifier.fillMaxWidth())
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Button(enabled = !busy && code.length >= 6, onClick = { go { session.code(code, recovery) } }, modifier = Modifier.fillMaxWidth()) { Text("Verify") }
                TextButton(onClick = { recovery = !recovery; code = "" }) { Text(if (recovery) "Use an authenticator code" else "Use a recovery code") }
                TextButton(onClick = { session.expired() }) { Text("Start over") }
            } else {
                Text("Sign in", style = MaterialTheme.typography.headlineMedium)
                Text("Your dashboard account. Two-factor sign-in is required.", color = LocalWire.current.muted)
                OutlinedTextField(user, { user = it.trim() }, label = { Text("Username") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(pass, { pass = it }, label = { Text("Password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth())
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Button(enabled = !busy && user.isNotBlank() && pass.isNotBlank(), onClick = { go { session.login(user, pass) } }, modifier = Modifier.fillMaxWidth()) { Text("Continue") }
            }
        }
    }
}

private enum class Tab(val label: String) { Overview("Overview"), Changelog("Changelog"), Sources("Sources"), Content("Content"), More("More") }

@Composable
private fun Panel(session: AdminSession, start: String, openSite: (String) -> Unit) {
    var tab by rememberSaveable { mutableStateOf(Tab.entries.firstOrNull { it.name.equals(start, true) } ?: Tab.Overview) }
    Scaffold(bottomBar = {
        NavigationBar {
            for (t in Tab.entries) NavigationBarItem(
                selected = tab == t, onClick = { tab = t }, label = { Text(t.label) },
                icon = {
                    Icon(
                        when (t) {
                            Tab.Overview -> Icons.Outlined.Dashboard
                            Tab.Changelog -> Icons.Outlined.NewReleases
                            Tab.Sources -> Icons.Outlined.RssFeed
                            Tab.Content -> Icons.Outlined.Article
                            Tab.More -> Icons.Outlined.MoreHoriz
                        },
                        contentDescription = null,
                    )
                },
            )
        }
    }) { pad ->
        Column(Modifier.padding(pad)) {
            when (tab) {
                Tab.Overview -> OverviewScreen(session)
                Tab.Changelog -> ChangelogScreen(session, openSite)
                Tab.Sources -> SourcesScreen(session)
                Tab.Content -> ContentScreen(session, openSite)
                Tab.More -> MoreScreen(session)
            }
        }
    }
}
