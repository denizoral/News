package com.frontierwire.app

import com.frontierwire.core.json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelsTest {
    private fun fixture(name: String) = javaClass.classLoader!!.getResource(name)!!.readText()

    @Test fun decodesALiveSnapshot() {
        val s = json.decodeFromString(Snapshot.serializer(), fixture("snapshot.json"))
        assertEquals(8, s.stories.size)
        assertTrue(s.stories.all { it.sid.isNotEmpty() && it.title.isNotEmpty() && it.publishedAt > 0 })
        assertEquals("abc123", s.breaking.first().sid)
        assertTrue(s.trending!!.topics.isNotEmpty())
    }

    @Test fun decodesTheServersAccountResponse() {
        val body = """{"token":"fwu_x","user":{"id":3,"email":"a@example.com","name":"Ada","hasPassword":true,"google":false,"emailVerified":false,"createdAt":1,
            "prefs":{"follows":{"topics":[],"names":[{"key":"openai","label":"OpenAI"}],"accounts":[],"outlets":[]},"alerts":{"breaking":true,"follows":true,"minOutlets":3,"maxPerDay":12,"quiet":null}}}}"""
        val r = json.decodeFromString(AuthResult.serializer(), body)
        assertEquals("OpenAI", r.user.prefs.follows.names.single().label)
        assertNull(r.user.prefs.alerts.quiet)
    }

    @Test fun followsMatchLikeTheServer() {
        val s = Story(sid = "s", title = "t", entities = listOf("nvidia"), topics = listOf("Chips"), sources = listOf(Source(name = "@sama", platform = "x"), Source(name = "The Verge", host = "www.theverge.com")))
        assertEquals("Nvidia", Follows().toggle("names", "Nvidia", "Nvidia").match(s))
        assertEquals("Chips", Follows().toggle("topics", "chips", "Chips").match(s))
        assertEquals("@sama", Follows().toggle("accounts", "sama", "@sama").match(s))
        assertEquals("theverge.com", Follows().toggle("outlets", "theverge.com", "theverge.com").match(s))
        assertNull(Follows().toggle("names", "apple", "Apple").match(s))
        val f = Follows().toggle("names", "openai", "OpenAI")
        assertEquals(0, f.toggle("names", "OpenAI", "OpenAI").count, "toggling again unfollows")
    }

    private fun assertEquals(expected: Int, actual: Int, msg: String) = org.junit.Assert.assertEquals(msg, expected.toLong(), actual.toLong())
}
