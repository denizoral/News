package com.frontierwire.app

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import coil.compose.AsyncImage
import com.frontierwire.core.LocalWire
import com.frontierwire.core.ago
import com.frontierwire.core.json
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class FeedModel : ViewModel() {
    val snapshot = MutableStateFlow<Snapshot?>(null)
    val error = MutableStateFlow<String?>(null)
    val loading = MutableStateFlow(false)

    fun load(session: Session) {
        if (loading.value) return
        loading.value = true
        viewModelScope.launch {
            runCatching { json.decodeFromJsonElement(Snapshot.serializer(), session.api.get("/api/snapshot")) }
                .onSuccess { snapshot.value = it; error.value = null }
                .onFailure { error.value = it.message }
            loading.value = false
        }
    }
}

/** Entity keys ("openai", "sam-altman") read as names. */
fun labelOf(key: String): String = LABELS[key] ?: key.split('-').joinToString(" ") { w -> w.replaceFirstChar { it.uppercase() } }
private val LABELS = mapOf("openai" to "OpenAI", "deepseek" to "DeepSeek", "xai" to "xAI", "nvidia" to "Nvidia", "amd" to "AMD", "ibm" to "IBM", "aws" to "AWS", "chatgpt" to "ChatGPT", "github" to "GitHub", "huggingface" to "Hugging Face", "eu" to "EU", "us" to "US")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TodayScreen(feed: FeedModel, session: Session, open: (String?, String?) -> Unit) {
    val snap by feed.snapshot.collectAsState()
    val loading by feed.loading.collectAsState()
    val err by feed.error.collectAsState()
    var menuFor by remember { mutableStateOf<Story?>(null) }
    PullToRefreshBox(isRefreshing = loading && snap != null, onRefresh = { feed.load(session) }, modifier = Modifier.fillMaxSize()) {
        LazyColumn(contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Header("Frontier Wire", "The AI news, as it breaks") }
            snap?.breaking?.firstOrNull()?.let { b -> item { BreakingBanner(b) { open(b.sid, null) } } }
            snap?.trending?.topics?.takeIf { it.isNotEmpty() }?.let { topics ->
                item {
                    Text("TRENDING NOW", style = MaterialTheme.typography.labelSmall, color = LocalWire.current.muted)
                    Spacer(Modifier.height(6.dp))
                    TrendingRow(topics, session)
                }
            }
            if (snap == null) item { if (err != null) Message(err!!) { feed.load(session) } else Skeletons() }
            snap?.stories?.let { list ->
                items(list.take(80), key = { it.sid.ifEmpty { it.url } }) { s -> StoryCard(s, onOpen = { open(s.sid.ifEmpty { null }, s.url) }, onMore = { menuFor = s }) }
            }
        }
    }
    menuFor?.let { s -> FollowSheet(s, session) { menuFor = null } }
}

@Composable
fun ForYouScreen(feed: FeedModel, session: Session, open: (String?, String?) -> Unit, goToAlerts: () -> Unit) {
    val snap by feed.snapshot.collectAsState()
    val prefs by session.prefs.collectAsState()
    var menuFor by remember { mutableStateOf<Story?>(null) }
    val matches = remember(snap, prefs) { (snap?.stories.orEmpty()).mapNotNull { s -> prefs.follows.match(s)?.let { s to it } } }
    LazyColumn(contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Header("For you", if (prefs.follows.count == 0) "Follow topics, names, X accounts and outlets" else "${prefs.follows.count} follows · ${matches.size} stories") }
        if (prefs.follows.count == 0) {
            item {
                Text("Start with what’s trending:", style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(8.dp))
                TrendingRow(snap?.trending?.topics.orEmpty(), session)
                Spacer(Modifier.height(8.dp))
                Text("Or tap ⋮ on any story to follow who and what it’s about.", style = MaterialTheme.typography.bodySmall, color = LocalWire.current.muted)
            }
        } else if (matches.isEmpty()) {
            item { Text("Nothing in today’s stories yet. You’ll get an alert when there is.", color = LocalWire.current.muted) }
        }
        items(matches, key = { it.first.sid.ifEmpty { it.first.url } }) { (s, why) ->
            StoryCard(s, reason = why, onOpen = { open(s.sid.ifEmpty { null }, s.url) }, onMore = { menuFor = s })
        }
        if (prefs.follows.count > 0) item { TextButton(onClick = goToAlerts) { Text("Manage follows and alerts") } }
    }
    menuFor?.let { s -> FollowSheet(s, session) { menuFor = null } }
}

@Composable
fun Header(title: String, sub: String) {
    Column(Modifier.padding(top = 8.dp, bottom = 4.dp)) {
        Text(title, style = MaterialTheme.typography.headlineMedium)
        Text(sub, style = MaterialTheme.typography.bodyMedium, color = LocalWire.current.muted)
    }
}

@Composable
private fun BreakingBanner(b: BreakingEvent, onClick: () -> Unit) {
    var shown by remember { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(b.sid) { shown = true }
    AnimatedVisibility(shown, enter = fadeIn(tween(400)) + slideInVertically(tween(400)) { -it / 2 }) {
        Surface(color = LocalWire.current.no, contentColor = Color.White, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)) {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(Color.White))
                Spacer(Modifier.width(10.dp))
                Column {
                    Text("BREAKING", style = MaterialTheme.typography.labelSmall)
                    Text(b.title, style = MaterialTheme.typography.titleMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
private fun TrendingRow(topics: List<TrendTopic>, session: Session) {
    val prefs by session.prefs.collectAsState()
    val scope = rememberCoroutineScope()
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(topics.take(12), key = { it.key }) { t ->
            val kind = "names"
            FilterChip(
                selected = prefs.follows.has(kind, t.key),
                onClick = { scope.launch { runCatching { session.toggleFollow(kind, t.key, t.label) } } },
                label = { Text(if (t.lift >= 1.5) "${t.label}  ${"%.1f".format(t.lift)}×" else t.label) },
            )
        }
    }
}

@Composable
fun StoryCard(s: Story, reason: String? = null, onOpen: () -> Unit, onMore: () -> Unit) {
    val w = LocalWire.current
    Card(
        onClick = onOpen,
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, w.line),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            if (!s.image.isNullOrBlank()) {
                AsyncImage(model = s.image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().height(168.dp))
            }
            Column(Modifier.padding(start = 16.dp, end = 4.dp, top = 12.dp, bottom = 8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        if (reason != null) Text(reason.uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        Text("${s.sourceName} · ${ago(s.publishedAt)}${if (s.outlets > 1) " · ${s.outlets} outlets" else ""}", style = MaterialTheme.typography.bodySmall, color = w.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    IconButton(onClick = onMore) { Icon(Icons.Filled.MoreVert, contentDescription = "Follow…", tint = w.muted) }
                }
                Text(s.title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(end = 12.dp))
                if (s.summary.isNotBlank()) {
                    Spacer(Modifier.height(4.dp))
                    Text(s.summary, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(end = 12.dp))
                }
                Spacer(Modifier.height(8.dp))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun FollowSheet(s: Story, session: Session, onDismiss: () -> Unit) {
    val prefs by session.prefs.collectAsState()
    val scope = rememberCoroutineScope()
    val options = buildList {
        s.entities.forEach { add(Triple("names", it, labelOf(it))) }
        s.topics.forEach { add(Triple("topics", it.lowercase(), it)) }
        s.sources.filter { it.platform == "x" }.map { it.name.removePrefix("@") }.distinct().take(3).forEach { add(Triple("accounts", it.lowercase(), "@$it")) }
        s.sources.mapNotNull { it.host?.removePrefix("www.") }.filter { it != "x.com" && it != "news.google.com" }.distinct().take(3).forEach { add(Triple("outlets", it, it)) }
    }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 32.dp)) {
            Text("Follow", style = MaterialTheme.typography.titleLarge)
            Text("Get stories about these in For you, and alerts when enough outlets cover them.", style = MaterialTheme.typography.bodySmall, color = LocalWire.current.muted)
            Spacer(Modifier.height(12.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for ((kind, key, label) in options) {
                    FilterChip(selected = prefs.follows.has(kind, key), onClick = { scope.launch { runCatching { session.toggleFollow(kind, key, label) } } }, label = { Text(label) })
                }
            }
            if (options.isEmpty()) Text("Nothing to follow on this story.", color = LocalWire.current.muted)
        }
    }
}

@Composable
fun Message(text: String, retry: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(text, color = LocalWire.current.muted)
        TextButton(onClick = retry) { Text("Try again") }
    }
}

@Composable
fun Skeletons() {
    val w = LocalWire.current
    val t = androidx.compose.animation.core.rememberInfiniteTransition(label = "sk")
    val a by t.animateFloat(0.35f, 0.75f, androidx.compose.animation.core.infiniteRepeatable(tween(900), androidx.compose.animation.core.RepeatMode.Reverse), label = "a")
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        repeat(4) { Surface(color = w.line.copy(alpha = a), shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().height(120.dp)) {} }
    }
}
