package com.frontierwire.app

import kotlinx.serialization.Serializable

@Serializable
data class Lead(val source: String? = null, val host: String? = null, val author: String? = null)

@Serializable
data class Source(val name: String = "", val url: String = "", val platform: String = "web", val host: String? = null)

@Serializable
data class Story(
    val sid: String = "",
    val title: String = "",
    val url: String = "",
    val summary: String = "",
    val image: String? = null,
    val lead: Lead? = null,
    val publishedAt: Long = 0,
    val sources: List<Source> = emptyList(),
    val topics: List<String> = emptyList(),
    val entities: List<String> = emptyList(),
) {
    val outlets get() = sources.filter { it.platform != "x" }.map { it.host ?: it.name }.distinct().size
    val sourceName get() = lead?.source ?: lead?.host ?: sources.firstOrNull()?.name ?: ""
}

@Serializable
data class Trending(val topics: List<TrendTopic> = emptyList())

@Serializable
data class TrendTopic(val key: String = "", val label: String = "", val count: Int = 0, val lift: Double = 0.0)

@Serializable
data class BreakingEvent(val sid: String = "", val title: String = "", val url: String? = null, val startedAt: Long = 0)

@Serializable
data class Snapshot(
    val version: Long = 0,
    val generatedAt: Long = 0,
    val stories: List<Story> = emptyList(),
    val tech: List<Story> = emptyList(),
    val trending: Trending? = null,
    val breaking: List<BreakingEvent> = emptyList(),
)

@Serializable
data class Follow(val key: String, val label: String = key)

@Serializable
data class Follows(
    val topics: List<Follow> = emptyList(),
    val names: List<Follow> = emptyList(),
    val accounts: List<Follow> = emptyList(),
    val outlets: List<Follow> = emptyList(),
) {
    val count get() = topics.size + names.size + accounts.size + outlets.size

    fun has(kind: String, key: String) = list(kind).any { it.key.equals(key, ignoreCase = true) }

    fun list(kind: String) = when (kind) {
        "topics" -> topics
        "names" -> names
        "accounts" -> accounts
        else -> outlets
    }

    fun toggle(kind: String, key: String, label: String): Follows {
        val k = key.lowercase()
        val cur = list(kind)
        val next = if (cur.any { it.key == k }) cur.filter { it.key != k } else (cur + Follow(k, label)).take(50)
        return when (kind) {
            "topics" -> copy(topics = next)
            "names" -> copy(names = next)
            "accounts" -> copy(accounts = next)
            else -> copy(outlets = next)
        }
    }

    /** Why a story matches, or null: the same rules the server uses for alerts. */
    fun match(s: Story): String? {
        names.firstOrNull { f -> s.entities.any { it.equals(f.key, true) } }?.let { return it.label }
        topics.firstOrNull { f -> s.topics.any { it.equals(f.key, true) } }?.let { return it.label }
        val handles = s.sources.filter { it.platform == "x" }.map { it.name.removePrefix("@").lowercase() }
        accounts.firstOrNull { it.key.removePrefix("@") in handles }?.let { return "@${it.key.removePrefix("@")}" }
        val hosts = s.sources.mapNotNull { it.host?.removePrefix("www.")?.lowercase() }
        outlets.firstOrNull { it.key.removePrefix("www.") in hosts }?.let { return it.label }
        return null
    }

    fun merge(o: Follows) = Follows(
        (topics + o.topics).distinctBy { it.key }, (names + o.names).distinctBy { it.key },
        (accounts + o.accounts).distinctBy { it.key }, (outlets + o.outlets).distinctBy { it.key },
    )
}

@Serializable
data class Quiet(val from: Int, val to: Int, val tz: Int = 0)

@Serializable
data class Alerts(
    val breaking: Boolean = true,
    val follows: Boolean = true,
    val minOutlets: Int = 3,
    val maxPerDay: Int = 12,
    val quiet: Quiet? = null,
)

@Serializable
data class Prefs(val follows: Follows = Follows(), val alerts: Alerts = Alerts())

@Serializable
data class User(
    val id: Long,
    val email: String,
    val name: String = "",
    val hasPassword: Boolean = false,
    val google: Boolean = false,
    val prefs: Prefs = Prefs(),
)

@Serializable
data class AuthResult(val token: String, val user: User)

@Serializable
data class ServerConfig(val google: Boolean = false, val googleClientId: String? = null, val push: Boolean = false, val passwordMin: Int = 12)
