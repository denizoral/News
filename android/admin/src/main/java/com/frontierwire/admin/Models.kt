package com.frontierwire.admin

import kotlinx.serialization.Serializable

@Serializable data class Counts(val total: Long = 0, val hidden: Long? = 0, val pinned: Long? = 0, val edited: Long? = 0, val crawled: Long? = 0)
@Serializable data class Crawler(val running: Boolean = false, val paused: Boolean = false, val pagesPerMinute: Double = 0.0, val queued: Long = 0, val crawledPages: Long = 0, val hosts: Long = 0, val errors: Long = 0)
@Serializable data class SourceRow(val name: String, val ok: Boolean? = null, val paused: Boolean = false, val count: Int? = null, val lastRun: Long? = null, val error: String? = null)
@Serializable data class Storage(val dbBytes: Long = 0, val mediaBytes: Long = 0, val images: Long = 0)
@Serializable data class FeedInfo(val stories: Int = 0, val builds: Int = 0, val markets: Int = 0, val generatedAt: Long = 0)
@Serializable data class Check(val ok: Boolean, val label: String, val fix: String = "")
@Serializable data class AuditEntry(val id: Long, val at: Long, val username: String? = null, val action: String, val target: String? = null, val ip: String? = null)
@Serializable data class Overview(
    val content: Counts = Counts(),
    val crawler: Crawler = Crawler(),
    val sources: List<SourceRow> = emptyList(),
    val storage: Storage = Storage(),
    val feed: FeedInfo = FeedInfo(),
    val security: List<Check> = emptyList(),
    val recentActivity: List<AuditEntry> = emptyList(),
)
@Serializable data class Feature(val id: String, val date: String, val title: String, val route: String? = null, val body: String = "")
@Serializable data class Changelog(val entries: List<Feature> = emptyList())
@Serializable data class SourceStatus(val ok: Boolean? = null, val count: Int? = null, val error: String? = null, val lastRun: Long? = null, val ms: Long? = null, val paused: Boolean = false)
@Serializable data class SourceInfo(val name: String, val status: SourceStatus? = null, val enabled: Boolean? = true, val intervalSec: Int? = null)
@Serializable data class Sources(val sources: List<SourceInfo> = emptyList())
@Serializable data class Doc(val id: Long, val url: String, val type: String, val title: String = "", val site: String? = null, val source: String? = null, val publishedAt: Long? = null, val firstSeen: Long? = null, val hidden: Boolean = false, val pinned: Boolean = false, val locked: Boolean = false)
@Serializable data class DocPage(val total: Long = 0, val page: Int = 1, val items: List<Doc> = emptyList())
@Serializable data class PushInfo(val enabled: Boolean = false, val devices: Int = 0, val sent: Int = 0, val failed: Int = 0, val lastSent: Long? = null, val lastError: String? = null)
@Serializable data class Readers(val accounts: Int = 0, val google: Int = 0, val newThisWeek: Int = 0, val activeThisWeek: Int = 0, val devices: Map<String, Int> = emptyMap(), val push: PushInfo = PushInfo())
@Serializable data class AuditPage(val entries: List<AuditEntry> = emptyList())
