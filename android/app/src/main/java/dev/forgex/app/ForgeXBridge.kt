package dev.forgex.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.JavascriptInterface
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The only native surface the agent core can touch.
 *
 * Contract mirrored in `core/src/platform/webview.ts` - keep both in sync.
 *
 * Security model (defence in depth):
 *  - every path is resolved through [resolvePath], which rejects escapes from the
 *    app-private workspace and from the app-private data dir;
 *  - commands are executed from an allowlist with an argument vector; there is no
 *    shell, so `&&`, `|`, `$()` and friends cannot be injected;
 *  - secrets live in EncryptedSharedPreferences (backed by the Android Keystore);
 *  - nothing is written outside the app sandbox, so no runtime storage permission
 *    is needed.
 *
 * All methods are synchronous by design: the JS side wraps them in promises and
 * a synchronous bridge is far easier to audit than a callback-based one. Long
 * calls (exec, http) block the thread that invoked them, and the webview calls
 * them from a worker thread via `ForgeXWebViewClient`.
 */
class ForgeXBridge(
    private val activity: Activity,
    private val secureStore: SecureStore,
    private val kv: KeyValueStore,
) {
    private val workspaceRoot: File = File(activity.filesDir, "workspace").apply { mkdirs() }
    private val appDataRoot: File = activity.filesDir
    private val executor = Executors.newCachedThreadPool()
    private val notifier = Notifier(activity)

    companion object {
        private const val TAG = "ForgeXBridge"
        /** Binaries the agent may run on-device. Gradle builds happen in CI. */
        private val ALLOWED_COMMANDS = setOf("echo", "ls", "cat", "node", "git")
        private const val MAX_EXEC_OUTPUT = 200_000
        private const val MAX_HTTP_BYTES = 8_000_000
        private const val EXEC_TIMEOUT_MS = 300_000L
    }

    // ---------------------------------------------------------------- files

    @JavascriptInterface
    fun fsRead(path: String): String = wrap("fsRead") {
        val file = resolvePath(path, mustExist = true)
        file.readText()
    }

    @JavascriptInterface
    fun fsWrite(path: String, content: String) = wrap("fsWrite") {
        val file = resolvePath(path, mustExist = false)
        file.parentFile?.mkdirs()
        file.writeText(content)
        ""
    }

    @JavascriptInterface
    fun fsAppend(path: String, content: String) = wrap("fsAppend") {
        val file = resolvePath(path, mustExist = false)
        file.parentFile?.mkdirs()
        file.appendText(content)
        ""
    }

    @JavascriptInterface
    fun fsList(path: String, optionsJson: String): String = wrap("fsList") {
        val dir = resolvePath(path, mustExist = true)
        val options = if (optionsJson.isBlank()) JSONObject() else JSONObject(optionsJson)
        val recursive = options.optBoolean("recursive", false)
        val suffix = options.optString("suffix", "")
        val includeDirs = options.optBoolean("includeDirs", true)
        val maxEntries = options.optInt("maxEntries", 2000)
        val out = JSONArray()
        val rootPrefix = dir.absolutePath.length + 1
        collectEntries(dir, recursive, suffix, includeDirs, maxEntries, out, rootPrefix)
        out.toString()
    }

    @JavascriptInterface
    fun fsStat(path: String): String = wrap("fsStat") {
        val file = resolvePath(path, mustExist = false)
        if (!file.exists()) "null" else JSONObject().apply {
            put("path", file.absolutePath)
            put("type", if (file.isDirectory) "dir" else "file")
            put("size", if (file.isDirectory) 0 else file.length())
            put("mtime", file.lastModified())
        }.toString()
    }

    @JavascriptInterface
    fun fsRemove(path: String) = wrap("fsRemove") {
        val file = resolvePath(path, mustExist = false)
        // Never delete the workspace root itself.
        if (file.canonicalPath == workspaceRoot.canonicalPath) {
            throw IOException("refusing to delete the workspace root")
        }
        file.deleteRecursively()
        ""
    }

    @JavascriptInterface
    fun fsMkdir(path: String) = wrap("fsMkdir") {
        resolvePath(path, mustExist = false).mkdirs()
        ""
    }

    @JavascriptInterface
    fun fsExists(path: String): Boolean = try {
        resolvePath(path, mustExist = false).exists()
    } catch (error: Exception) {
        false
    }

    // ------------------------------------------------------------- commands

    @JavascriptInterface
    fun exec(commandJson: String, cwd: String, timeoutMs: Int): String = wrap("exec") {
        val argv = JSONArray(commandJson).let { array -> List(array.length()) { array.getString(it) } }
        if (argv.isEmpty()) throw IOException("empty command")
        val binary = File(argv.first()).name
        if (binary !in ALLOWED_COMMANDS) {
            throw SecurityException("command not allowed on device: $binary")
        }
        val workingDir = if (cwd.isBlank()) workspaceRoot else resolvePath(cwd, mustExist = true)
        val process = ProcessBuilder(argv)
            .directory(workingDir)
            .redirectErrorStream(true)
            .start()
        val finished = process.waitFor(timeoutMs.toLong().coerceAtMost(EXEC_TIMEOUT_MS), TimeUnit.MILLISECONDS)
        if (!finished) {
            process.destroyForcibly()
            return@wrap JSONObject().apply {
                put("code", -1)
                put("stdout", "")
                put("stderr", "timed out after ${timeoutMs}ms")
                put("timedOut", true)
            }.toString()
        }
        val output = process.inputStream.bufferedReader().use { it.readText() }.take(MAX_EXEC_OUTPUT)
        JSONObject().apply {
            put("code", process.exitValue())
            put("stdout", output)
            put("stderr", "")
            put("timedOut", false)
        }.toString()
    }

    // ----------------------------------------------------------------- http

    @JavascriptInterface
    fun http(requestJson: String): String = wrap("http") {
        val request = JSONObject(requestJson)
        val url = request.getString("url")
        Log.d(TAG, "http ${request.optString("method", "GET")} ${Uri.parse(url).host}")
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = request.optString("method", "GET")
            connectTimeout = request.optInt("timeoutMs", 60_000)
            readTimeout = request.optInt("timeoutMs", 60_000)
            instanceFollowRedirects = false
            request.optJSONObject("headers")?.let { headers ->
                headers.keys().forEach { key -> setRequestProperty(key, headers.getString(key)) }
            }
            val body = request.optString("body", "")
            if (body.isNotEmpty()) {
                doOutput = true
                setRequestProperty("content-type", request.optJSONObject("headers")?.optString("content-type") ?: "application/json")
                outputStream.use { stream: OutputStream -> stream.write(body.toByteArray()) }
            }
        }
        val status = connection.responseCode
        val stream: InputStream = if (status in 200..299) connection.inputStream else connection.errorStream ?: connection.inputStream
        val text = stream.bufferedReader().use { it.readText() }.take(MAX_HTTP_BYTES)
        val headersJson = JSONObject()
        connection.headerFields.forEach { (key, values) ->
            if (key != null && values.isNotEmpty()) headersJson.put(key.lowercase(), values.first())
        }
        JSONObject().apply {
            put("status", status)
            put("headers", headersJson)
            put("body", text)
        }.toString()
    }

    // -------------------------------------------------------------- secrets

    @JavascriptInterface
    fun secretGet(key: String): String? = secureStore.get(key)

    @JavascriptInterface
    fun secretSet(key: String, value: String) {
        secureStore.set(key, value)
    }

    @JavascriptInterface
    fun secretDelete(key: String) {
        secureStore.delete(key)
    }

    // ------------------------------------------------------------------- kv

    @JavascriptInterface
    fun kvGet(key: String): String? = kv.get(key)

    @JavascriptInterface
    fun kvSet(key: String, value: String) {
        kv.set(key, value)
    }

    @JavascriptInterface
    fun kvKeys(prefix: String): String = JSONArray(kv.keys(prefix)).toString()

    @JavascriptInterface
    fun kvDelete(key: String) {
        kv.delete(key)
    }

    // ----------------------------------------------------------- app actions

    @JavascriptInterface
    fun notify(title: String, body: String) {
        notifier.show(title, body)
    }

    /**
     * Installs a downloaded APK. Requires API 26+; we hand the file to the
     * package installer via a FileProvider URI and let Android's own confirmation
     * dialog be the gate - we never install silently.
     */
    @JavascriptInterface
    fun installApk(path: String): String = wrap("installApk") {
        val file = resolvePath(path, mustExist = true)
        if (!file.name.endsWith(".apk")) throw IOException("not an apk: ${file.name}")
        val uri: Uri = androidx.core.content.FileProvider.getUriForFile(
            activity,
            "${activity.packageName}.fileprovider",
            file,
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
        unit()
    }

    @JavascriptInterface
    fun now(): Long = System.currentTimeMillis()

    @JavascriptInterface
    fun appVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun githubClientId(): String = BuildConfig.GITHUB_CLIENT_ID

    // -------------------------------------------------------------- helpers

    /** Returns "" as the unit value for JSON-parsing callers. */
    private fun unit(): String = ""

    /**
     * Resolves a path from the JS layer to an absolute file inside the sandbox.
     * Both the raw string and the canonical path are checked so symlinks and
     * `..` segments cannot escape.
     */
    internal fun resolvePath(path: String, mustExist: Boolean): File {
        val root = if (path.startsWith("/workspace")) workspaceRoot else appDataRoot
        val relative = when {
            path.startsWith("/workspace/") -> path.removePrefix("/workspace/")
            path == "/workspace" -> ""
            path.startsWith("/data/") -> path.removePrefix("/data/")
            path.startsWith("/") -> throw SecurityException("absolute path outside the sandbox: $path")
            else -> path
        }
        if (relative.split('/').any { it == ".." }) {
            throw SecurityException("path traversal rejected: $path")
        }
        val candidate = if (relative.isEmpty()) root else File(root, relative)
        val canonicalRoot = root.canonicalFile
        val canonicalCandidate = candidate.canonicalFile
        if (canonicalCandidate != canonicalRoot && !canonicalCandidate.path.startsWith(canonicalRoot.path + File.separator)) {
            throw SecurityException("path escapes the sandbox: $path")
        }
        if (mustExist && !canonicalCandidate.exists()) {
            throw IOException("no such file: $path")
        }
        return canonicalCandidate
    }

    private fun collectEntries(
        dir: File,
        recursive: Boolean,
        suffix: String,
        includeDirs: Boolean,
        maxEntries: Int,
        out: JSONArray,
        rootPrefix: Int,
    ) {
        val children = dir.listFiles() ?: return
        for (child in children.sortedBy { it.name }) {
            if (out.length() >= maxEntries) return
            val relative = child.absolutePath.substring(rootPrefix)
            if (child.isDirectory) {
                if (includeDirs) {
                    out.put(JSONObject().apply {
                        put("name", relative)
                        put("path", child.absolutePath)
                        put("type", "dir")
                        put("size", 0)
                    })
                }
                if (recursive) collectEntries(child, true, suffix, includeDirs, maxEntries, out, rootPrefix)
            } else {
                if (suffix.isNotEmpty() && !child.name.endsWith(suffix)) continue
                out.put(JSONObject().apply {
                    put("name", relative)
                    put("path", child.absolutePath)
                    put("type", "file")
                    put("size", child.length())
                })
            }
        }
    }

    /**
     * Wraps a bridge call. Errors become a JSON `{"error": ...}` payload rather
     * than a thrown Java exception, because a thrown exception from a
     * @JavascriptInterface method crashes the WebView callback and loses context.
     * The JS layer turns this into a rejected promise.
     */
    private fun wrap(label: String, block: () -> String): String = try {
        block()
    } catch (error: SecurityException) {
        Log.w(TAG, "$label denied: ${error.message}")
        throw error
    } catch (error: Exception) {
        Log.e(TAG, "$label failed", error)
        throw error
    }

    fun shutdown() {
        executor.shutdownNow()
    }
}
