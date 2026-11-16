package dev.forgex.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import android.util.Log

/**
 * Secrets (provider keys, GitHub token) in EncryptedSharedPreferences, whose
 * master key is held by the Android Keystore. Nothing here is ever written to
 * the workspace, a log, or git.
 */
class SecureStore(context: Context) {
    companion object {
        private const val TAG = "ForgeXSecureStore"
        private const val FILE = "forgex_secure"
    }

    private val prefs: SharedPreferences? = try {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (error: Exception) {
        Log.e(TAG, "encrypted storage unavailable", error)
        null
    }

    fun get(key: String): String? = prefs?.getString(key, null)

    fun set(key: String, value: String) {
        prefs?.edit()?.putString(key, value)?.apply()
    }

    fun delete(key: String) {
        prefs?.edit()?.remove(key)?.apply()
    }

    fun isAvailable(): Boolean = prefs != null
}
