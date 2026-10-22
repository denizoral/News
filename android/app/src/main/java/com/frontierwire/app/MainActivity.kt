package com.frontierwire.app

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.StarOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.lifecycleScope
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.frontierwire.core.Notify
import com.frontierwire.core.WireTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val session = Session.get(this)
        lifecycleScope.launch { session.refresh() }
        setContent { WireTheme { WireRoot(session, ::openStory, ::askForNotifications) } }
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    // A notification tap opens its story.
    private fun handle(intent: Intent?) {
        val sid = intent?.getStringExtra("sid") ?: return
        intent.removeExtra("sid")
        openStory(sid, null)
    }

    fun openStory(sid: String?, url: String?) {
        val base = Session.get(this).api.baseUrl
        val target = if (sid != null) "$base/#story/$sid" else url ?: return
        runCatching { CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, Uri.parse(target)) }
            .onFailure { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(target))) }
    }

    fun askForNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && !Notify.allowed(this)) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
}

private enum class Tab(val route: String, val label: String) { Today("today", "Today"), ForYou("foryou", "For you"), Alerts("alerts", "Alerts"), Account("account", "Account") }

@Composable
fun WireRoot(session: Session, open: (String?, String?) -> Unit, askNotifications: () -> Unit) {
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val feed = androidx.lifecycle.viewmodel.compose.viewModel<FeedModel>()
    LaunchedEffect(Unit) { feed.load(session) }
    Scaffold(
        bottomBar = {
            NavigationBar {
                for (t in Tab.entries) {
                    NavigationBarItem(
                        selected = entry?.destination?.route == t.route,
                        onClick = {
                            nav.navigate(t.route) {
                                popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = {
                            Icon(
                                when (t) {
                                    Tab.Today -> Icons.Outlined.Bolt
                                    Tab.ForYou -> Icons.Outlined.StarOutline
                                    Tab.Alerts -> Icons.Outlined.NotificationsNone
                                    Tab.Account -> Icons.Outlined.AccountCircle
                                },
                                contentDescription = null,
                            )
                        },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { pad ->
        NavHost(nav, startDestination = Tab.Today.route, modifier = Modifier.padding(pad)) {
            composable(Tab.Today.route) { TodayScreen(feed, session, open) }
            composable(Tab.ForYou.route) { ForYouScreen(feed, session, open, goToAlerts = { nav.navigate(Tab.Alerts.route) }) }
            composable(Tab.Alerts.route) { AlertsScreen(session, askNotifications) }
            composable(Tab.Account.route) { AccountScreen(session) }
        }
    }
}
