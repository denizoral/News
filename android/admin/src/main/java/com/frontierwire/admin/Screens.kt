package com.frontierwire.admin

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.frontierwire.core.LocalWire
import com.frontierwire.core.ago
import com.frontierwire.core.dayLabel
import com.frontierwire.core.json
import kotlinx.coroutines.launch
import kotlinx.serialization.KSerializer
import java.net.URLEncoder

/** Loads [path] into [T]; pull down to reload. A lapsed session signs out. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun <T> Loaded(session: AdminSession, path: String, ser: KSerializer<T>, reload: Int = 0, content: LazyListScope.(T, () -> Unit) -> Unit) {
    var data by remember(path) { mutableStateOf<T?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var tick by remember { mutableIntStateOf(0) }
    LaunchedEffect(path, tick, reload) {
        busy = true
        session.call { json.decodeFromJsonElement(ser, get(path)) }.onSuccess { data = it; error = null }.onFailure { error = it.message }
        busy = false
    }
    PullToRefreshBox(isRefreshing = busy && data != null, onRefresh = { tick++ }, modifier = Modifier.fillMaxSize()) {
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxSize()) {
            error?.let { e -> item { Text(e, color = MaterialTheme.colorScheme.error) } }
            data?.let { content(it) { tick++ } } ?: if (error == null) item { Text("Loading…", color = LocalWire.current.muted) } else Unit
        }
    }
}

@Composable
private fun Tile(title: String? = null, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Card(shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), border = BorderStroke(1.dp, LocalWire.current.line), modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            if (title != null) {
                Text(title.uppercase(), style = MaterialTheme.typography.labelSmall, color = LocalWire.current.muted)
                Spacer(Modifier.height(8.dp))
            }
            content()
        }
    }
}

@Composable
private fun Head(title: String, sub: String? = null) {
    Column(Modifier.padding(top = 8.dp)) {
        Text(title, style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground)
        sub?.let { Text(it, color = LocalWire.current.muted, style = MaterialTheme.typography.bodyMedium) }
    }
}

@Composable
private fun Stat(value: String, label: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(value, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.ExtraBold)
        Text(label, style = MaterialTheme.typography.bodySmall, color = LocalWire.current.muted)
    }
}

/** Status dot plus a word: never colour alone. */
@Composable
private fun Health(ok: Boolean?, paused: Boolean = false) {
    val w = LocalWire.current
    val (c, word) = when {
        paused -> w.muted to "Paused"
        ok == null -> w.muted to "Not run"
        ok -> w.yes to "OK"
        else -> w.no to "Failing"
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        androidx.compose.foundation.layout.Box(Modifier.size(8.dp).background(c, CircleShape))
        Spacer(Modifier.width(6.dp))
        Text(word, style = MaterialTheme.typography.labelMedium, color = c)
    }
}

private fun bytes(n: Long) = when {
    n >= 1L shl 30 -> "%.1f GB".format(n / (1L shl 30).toDouble())
    n >= 1L shl 20 -> "%.0f MB".format(n / (1L shl 20).toDouble())
    else -> "${n / 1024} KB"
}
private fun num(n: Long) = if (n >= 10_000) "%,d".format(n) else n.toString()

@Composable
fun OverviewScreen(session: AdminSession) = Loaded(session, "/api/admin/overview", Overview.serializer()) { o, _ ->
    item { Head("Overview", "Feed rebuilt ${ago(o.feed.generatedAt)} ago") }
    item {
        Tile("Feed") {
            Row(Modifier.fillMaxWidth()) {
                Stat(o.feed.stories.toString(), "stories", Modifier.weight(1f))
                Stat(o.feed.markets.toString(), "markets", Modifier.weight(1f))
                Stat(num(o.content.total), "documents", Modifier.weight(1f))
            }
        }
    }
    item {
        val bad = o.sources.filter { it.ok == false && !it.paused }
        Tile("Sources") {
            Text("${o.sources.count { it.ok == true }} of ${o.sources.size} working", style = MaterialTheme.typography.titleMedium)
            for (s in bad) {
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) { Health(false); Spacer(Modifier.width(8.dp)); Text(s.name, fontWeight = FontWeight.Bold) }
                s.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = LocalWire.current.muted, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
        }
    }
    item {
        Tile("Crawler") {
            Row(Modifier.fillMaxWidth()) {
                Stat(if (o.crawler.paused) "Paused" else if (o.crawler.running) "%.0f/min".format(o.crawler.pagesPerMinute) else "Idle", "pages", Modifier.weight(1f))
                Stat(num(o.crawler.queued), "queued", Modifier.weight(1f))
                Stat(num(o.crawler.errors), "errors", Modifier.weight(1f))
            }
        }
    }
    item {
        Tile("Storage") {
            Row(Modifier.fillMaxWidth()) {
                Stat(bytes(o.storage.dbBytes), "database", Modifier.weight(1f))
                Stat(bytes(o.storage.mediaBytes), "images", Modifier.weight(1f))
                Stat(num(o.content.hidden ?: 0), "hidden", Modifier.weight(1f))
            }
        }
    }
    val failing = o.security.filter { !it.ok }
    if (failing.isNotEmpty()) item {
        Tile("Security · ${failing.size} to fix") {
            for (c in failing) {
                Text(c.label, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium)
                Text(c.fix, style = MaterialTheme.typography.bodySmall, color = LocalWire.current.muted)
                Spacer(Modifier.height(8.dp))
            }
        }
    }
    if (o.recentActivity.isNotEmpty()) item {
        Tile("Recent activity") { for (e in o.recentActivity.take(6)) AuditRow(e) }
    }
}

/** FEATURES.md's light markdown: **bold**, `code`, and "- " bullets. */
private fun md(line: String): AnnotatedString = buildAnnotatedString {
    var i = 0
    val re = Regex("""\*\*(.+?)\*\*|`([^`]+)`""")
    for (m in re.findAll(line)) {
        append(line.substring(i, m.range.first))
        if (m.groupValues[1].isNotEmpty()) withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(m.groupValues[1]) }
        else withStyle(SpanStyle(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace)) { append(m.groupValues[2]) }
        i = m.range.last + 1
    }
    append(line.substring(i))
}

@Composable
private fun MdBody(body: String) {
    // Re-flow wrapped lines into paragraphs and bullets.
    val blocks = mutableListOf<Pair<Int, String>>() // indent level (-1 = paragraph), text
    for (raw in body.lines()) {
        val t = raw.trimEnd()
        val bullet = Regex("""^(\s*)[-*]\s+(.*)$""").find(t)
        when {
            t.isBlank() -> blocks.add(-2 to "")
            bullet != null -> blocks.add(bullet.groupValues[1].length / 2 to bullet.groupValues[2])
            blocks.isNotEmpty() && blocks.last().first != -2 -> blocks[blocks.lastIndex] = blocks.last().first to blocks.last().second + " " + t.trim()
            else -> blocks.add(-1 to t.trim())
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for ((lvl, text) in blocks) {
            if (lvl == -2 || text.isBlank()) continue
            if (lvl >= 0) Row(Modifier.padding(start = (lvl * 14).dp)) { Text("•  ", color = LocalWire.current.muted); Text(md(text), style = MaterialTheme.typography.bodyMedium) }
            else Text(md(text), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
fun ChangelogScreen(session: AdminSession, openSite: (String) -> Unit) = Loaded(session, "/api/admin/changelog?limit=100", Changelog.serializer()) { c, _ ->
    item { Head("Changelog", "${c.entries.size} features shipped · newest first") }
    var lastDay: String? = null
    for (e in c.entries) {
        if (e.date != lastDay) {
            lastDay = e.date
            item(key = "d-${e.date}") { Text(dayLabel(e.date).uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 8.dp)) }
        }
        item(key = e.id) { FeatureCard(e, openSite) }
    }
}

/** One shipped feature: title and first line; tap for the whole entry. */
@Composable
internal fun FeatureCard(e: Feature, openSite: (String) -> Unit, startOpen: Boolean = false) {
    var open by remember { mutableStateOf(startOpen) }
    Tile(modifier = Modifier.clickable { open = !open }.animateContentSize()) {
        Text(e.title, style = MaterialTheme.typography.titleMedium)
        val lead = e.body.lines().firstOrNull { it.isNotBlank() }?.replace("**", "")?.removePrefix("- ") ?: ""
        if (!open) Text(lead, style = MaterialTheme.typography.bodySmall, color = LocalWire.current.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        else {
            Spacer(Modifier.height(8.dp))
            MdBody(e.body)
            e.route?.let { r -> TextButton(onClick = { openSite("/$r") }) { Text("Open $r on the site") } }
        }
    }
}

@Composable
fun SourcesScreen(session: AdminSession) {
    val scope = rememberCoroutineScope()
    var note by remember { mutableStateOf<String?>(null) }
    Loaded(session, "/api/admin/sources", Sources.serializer()) { s, reload ->
        item { Head("Sources", "${s.sources.count { it.status?.ok == true }} of ${s.sources.size} working") }
        note?.let { n -> item { Text(n, color = LocalWire.current.muted) } }
        items(s.sources, key = { it.name }) { src ->
            Tile {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(src.name, style = MaterialTheme.typography.titleMedium)
                        Text(listOfNotNull(src.status?.count?.let { "$it items" }, src.status?.lastRun?.let { "ran ${ago(it)} ago" }, src.intervalSec?.let { "every ${it / 60} min" }, if (src.enabled == false) "disabled" else null).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = LocalWire.current.muted)
                    }
                    Health(src.status?.ok, src.status?.paused == true || src.enabled == false)
                }
                src.status?.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = LocalWire.current.no, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp)) }
                OutlinedButton(onClick = {
                    note = "Running ${src.name}…"
                    scope.launch {
                        session.call { post("/api/admin/sources/${src.name}/run") }.onSuccess { note = "${src.name} ran."; reload() }.onFailure { note = it.message }
                    }
                }, modifier = Modifier.padding(top = 8.dp)) { Text("Run now") }
            }
        }
    }
}

@Composable
fun ContentScreen(session: AdminSession, openSite: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var q by remember { mutableStateOf("") }
    var applied by remember { mutableStateOf("") }
    var state by remember { mutableStateOf("visible") }
    var reload by remember { mutableIntStateOf(0) }
    var note by remember { mutableStateOf<String?>(null) }
    Column {
        Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp)) {
            Head("Content")
            OutlinedTextField(q, { q = it }, label = { Text("Search documents") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = { applied = q }), keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 8.dp)) {
                items(listOf("visible" to "Visible", "hidden" to "Hidden", "pinned" to "Pinned", "edited" to "Edited")) { (k, l) -> FilterChip(selected = state == k, onClick = { state = k }, label = { Text(l) }) }
            }
            note?.let { Text(it, color = LocalWire.current.muted, style = MaterialTheme.typography.bodySmall) }
        }
        Loaded(session, "/api/admin/content?state=$state&search=${URLEncoder.encode(applied, "UTF-8")}", DocPage.serializer(), reload) { p, _ ->
            item { Text("${num(p.total)} documents", color = LocalWire.current.muted) }
            items(p.items, key = { it.id }) { d ->
                Tile {
                    Text("${d.type.uppercase()} · ${d.source ?: d.site ?: ""}${(d.publishedAt ?: d.firstSeen)?.let { " · ${ago(it)}" } ?: ""}", style = MaterialTheme.typography.labelSmall, color = LocalWire.current.muted)
                    Text(d.title.ifBlank { d.url }, style = MaterialTheme.typography.titleSmall, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable { openSite("/#search?q=${URLEncoder.encode(d.title, "UTF-8")}") })
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 6.dp)) {
                        fun set(field: String, v: Boolean, done: String) = scope.launch {
                            session.call { patch("/api/admin/content/${d.id}", mapOf(field to v)) }.onSuccess { note = done; reload++ }.onFailure { note = it.message }
                        }
                        OutlinedButton(onClick = { set("hidden", !d.hidden, if (d.hidden) "Restored." else "Hidden from the site.") }) { Text(if (d.hidden) "Unhide" else "Hide") }
                        OutlinedButton(onClick = { set("pinned", !d.pinned, if (d.pinned) "Unpinned." else "Pinned.") }) { Text(if (d.pinned) "Unpin" else "Pin") }
                    }
                }
            }
        }
    }
}

@Composable
private fun AuditRow(e: AuditEntry) {
    Column(Modifier.padding(vertical = 4.dp)) {
        Text(e.action.replace('.', ' ').replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
        Text(listOfNotNull(e.username, e.target?.take(60), ago(e.at)).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = LocalWire.current.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun MoreScreen(session: AdminSession) {
    val scope = rememberCoroutineScope()
    Loaded(session, "/api/admin/readers", Readers.serializer()) { r, _ ->
        item { Head("Readers and apps") }
        item {
            Tile("Accounts") {
                Row(Modifier.fillMaxWidth()) {
                    Stat(r.accounts.toString(), "accounts", Modifier.weight(1f))
                    Stat(r.newThisWeek.toString(), "new this week", Modifier.weight(1f))
                    Stat(r.activeThisWeek.toString(), "active", Modifier.weight(1f))
                }
            }
        }
        item {
            Tile("Push") {
                Row(Modifier.fillMaxWidth()) {
                    Stat((r.devices["wire"] ?: 0).toString(), "reader phones", Modifier.weight(1f))
                    Stat((r.devices["admin"] ?: 0).toString(), "admin phones", Modifier.weight(1f))
                    Stat(r.push.sent.toString(), "sent since restart", Modifier.weight(1f))
                }
                Spacer(Modifier.height(8.dp))
                Text(if (r.push.enabled) "Firebase is set up." else "Firebase isn’t set up yet: phones check in the background instead. Put the service account key in data/firebase-service-account.json on the server.", style = MaterialTheme.typography.bodySmall, color = if (r.push.enabled) LocalWire.current.yes else LocalWire.current.warn)
                r.push.lastError?.let { Text("Last error: $it", style = MaterialTheme.typography.bodySmall, color = LocalWire.current.no) }
            }
        }
        item {
            var audit by remember { mutableStateOf<List<AuditEntry>?>(null) }
            LaunchedEffect(Unit) { audit = session.call { json.decodeFromJsonElement(AuditPage.serializer(), get("/api/admin/audit")) }.getOrNull()?.entries }
            audit?.let { list -> Tile("Audit log") { for (e in list.take(30)) AuditRow(e) } }
        }
        item {
            Tile("Signed in as ${session.username.value ?: ""}") {
                OutlinedButton(onClick = { scope.launch { session.logout() } }) { Text("Sign out") }
            }
        }
    }
}
