package com.frontierwire.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** An error the server explained, or a network failure in plain words. */
class ApiError(val status: Int, message: String) : IOException(message)

val json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
}

/**
 * The Frontier Wire HTTP API. Every call sends `X-Client` so the server knows
 * an app is talking (the admin API hands the admin app a bearer token instead
 * of a cookie), and the session token as `Authorization: Bearer …` when there
 * is one.
 */
class Api(
    private val base: String = BuildConfig.API_BASE,
    private val client: String,
    private val token: () -> String?,
) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val jsonType = "application/json".toMediaType()

    val baseUrl get() = base.trimEnd('/')

    suspend fun get(path: String): JsonElement = call("GET", path, null)
    suspend fun post(path: String, body: Any? = emptyMap<String, String>()): JsonElement = call("POST", path, body)
    suspend fun put(path: String, body: Any?): JsonElement = call("PUT", path, body)

    suspend inline fun <reified T> getAs(path: String): T = json.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), get(path))
    suspend inline fun <reified T> postAs(path: String, body: Any?): T = json.decodeFromJsonElement(kotlinx.serialization.serializer<T>(), post(path, body))

    private suspend fun call(method: String, path: String, body: Any?): JsonElement = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(baseUrl + path).header("X-Client", client).header("Accept", "application/json")
        token()?.let { req.header("Authorization", "Bearer $it") }
        if (method != "GET") req.method(method, toJson(body).toString().toRequestBody(jsonType))
        try {
            http.newCall(req.build()).execute().use { res ->
                val text = res.body?.string().orEmpty()
                val el = runCatching { json.parseToJsonElement(text) }.getOrNull()
                if (!res.isSuccessful) {
                    val msg = (el as? JsonObject)?.get("error")?.jsonPrimitive?.content ?: "The server answered ${res.code}."
                    throw ApiError(res.code, msg)
                }
                el ?: JsonObject(emptyMap())
            }
        } catch (e: ApiError) {
            throw e
        } catch (e: IOException) {
            throw ApiError(0, "Can’t reach the server. Check your connection.")
        }
    }

    companion object {
        fun toJson(v: Any?): JsonElement = when (v) {
            null -> kotlinx.serialization.json.JsonNull
            is JsonElement -> v
            is String -> kotlinx.serialization.json.JsonPrimitive(v)
            is Number -> kotlinx.serialization.json.JsonPrimitive(v)
            is Boolean -> kotlinx.serialization.json.JsonPrimitive(v)
            is Map<*, *> -> JsonObject(v.entries.associate { (k, x) -> k.toString() to toJson(x) })
            is List<*> -> kotlinx.serialization.json.JsonArray(v.map { toJson(it) })
            else -> error("Can't send ${v::class.simpleName} as JSON")
        }
    }
}

fun JsonElement.str(key: String): String? = runCatching { jsonObject[key]?.jsonPrimitive?.content }.getOrNull()
