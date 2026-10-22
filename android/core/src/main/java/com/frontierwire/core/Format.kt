package com.frontierwire.core

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** "5m", "3h", "Oct 21" — like the site. */
fun ago(ms: Long, now: Long = System.currentTimeMillis()): String {
    val s = (now - ms) / 1000
    return when {
        s < 60 -> "now"
        s < 3600 -> "${s / 60}m"
        s < 86400 -> "${s / 3600}h"
        s < 7 * 86400 -> "${s / 86400}d"
        else -> DateTimeFormatter.ofPattern("MMM d", Locale.ENGLISH).withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(ms))
    }
}

fun dayLabel(iso: String): String = runCatching {
    DateTimeFormatter.ofPattern("EEE, MMM d", Locale.ENGLISH).format(java.time.LocalDate.parse(iso))
}.getOrDefault(iso)
