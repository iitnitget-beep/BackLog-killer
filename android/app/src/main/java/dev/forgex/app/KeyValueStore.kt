package dev.forgex.app

import android.content.Context
import android.util.Log

/**
 * Durable store for the event log and resumable run state.
 *
 * Implementation note: this is a small SQLite table rather than Room. Room's
 * annotation processor adds build time and a second schema layer for what is
 * literally a string key/value store; a hand-written table keeps the APK small
 * and the CI build fast. The JS layer only needs get/set/keys/delete.
 */
class KeyValueStore(context: Context) : AutoCloseable {
    private val helper = object : android.database.sqlite.SQLiteOpenHelper(context, "forgex.db", null, 1) {
        override fun onCreate(db: android.database.sqlite.SQLiteDatabase) {
            db.execSQL("CREATE TABLE kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
        }
        override fun onUpgrade(db: android.database.sqlite.SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            Log.i("ForgeXKeyValueStore", "schema upgrade $oldVersion -> $newVersion")
        }
    }

    fun get(key: String): String? {
        helper.readableDatabase.query("kv", arrayOf("value"), "key = ?", arrayOf(key), null, null, null).use { cursor ->
            return if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }

    fun set(key: String, value: String) {
        helper.writableDatabase.insertWithOnConflict(
            "kv",
            null,
            android.content.ContentValues().apply {
                put("key", key)
                put("value", value)
            },
            android.database.sqlite.SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    fun delete(key: String) {
        helper.writableDatabase.delete("kv", "key = ?", arrayOf(key))
    }

    fun keys(prefix: String): List<String> {
        val out = mutableListOf<String>()
        helper.readableDatabase.query(
            "kv",
            arrayOf("key"),
            "key LIKE ?",
            arrayOf("$prefix%"),
            null,
            null,
            "key ASC",
        ).use { cursor ->
            while (cursor.moveToNext()) out.add(cursor.getString(0))
        }
        return out
    }

    override fun close() {
        helper.close()
    }
}
