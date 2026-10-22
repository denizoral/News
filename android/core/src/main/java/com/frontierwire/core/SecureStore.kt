package com.frontierwire.core

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small secrets (session tokens) encrypted with an AES-GCM key that lives in
 * the Android Keystore and never leaves it. Anything that can't be decrypted
 * (a restored backup on a new phone, a wiped key) reads as absent.
 */
class SecureStore(context: Context, name: String) {
    private val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)
    private val alias = "fw.$name"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    fun put(k: String, v: String?) {
        if (v == null) {
            prefs.edit().remove(k).apply()
            return
        }
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val out = c.iv + c.doFinal(v.toByteArray())
        prefs.edit().putString(k, Base64.encodeToString(out, Base64.NO_WRAP)).apply()
    }

    fun get(k: String): String? = runCatching {
        val raw = Base64.decode(prefs.getString(k, null) ?: return null, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12)) }
        String(c.doFinal(raw, 12, raw.size - 12))
    }.getOrNull()
}
