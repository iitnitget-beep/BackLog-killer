package dev.forgex.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.io.IOException

/**
 * Single-activity host. The whole UI is the bundled web app in
 * assets/app/index.html; Kotlin's job is the sandbox bridge, notifications and
 * the APK install intent.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var bridge: ForgeXBridge
    private lateinit var kv: KeyValueStore

    companion object {
        private const val TAG = "ForgeXMain"
        private const val NOTIFICATION_PERMISSION_REQUEST = 42
        private const val APP_URL = "https://appassets.androidplatform.net/assets/app/index.html"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        kv = KeyValueStore(this)
        val secureStore = SecureStore(this)
        bridge = ForgeXBridge(this, secureStore, kv)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.setSupportZoom(false)
            // Never load remote content: the UI is a local asset bundle. All
            // network traffic goes through the bridge, which logs the host.
            webViewClient = LocalOnlyWebViewClient()
            addJavascriptInterface(bridge, "forgeXBridge")
        }

        setContentView(webView)
        webView.loadUrl(APP_URL)

        if (!secureStore.isAvailable()) {
            // Visible failure instead of silently storing keys in plaintext.
            setContentView(TextView(this).apply {
                text = getString(R.string.secure_storage_unavailable)
                setPadding(48, 96, 48, 48)
            })
            Log.e(TAG, "secure storage unavailable; refusing to start")
            return
        }
        requestNotificationPermission()
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
    }

    /** Blocks every navigation except our own asset bundle. */
    private inner class LocalOnlyWebViewClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val host = request.url.host ?: return true
            return host != "appassets.androidplatform.net"
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            // Resolve asset requests from /assets/app/ explicitly so the WebView
            // cannot be tricked into reading files outside the asset bundle.
            val url = request.url
            if (url.host != "appassets.androidplatform.net") return null
            val path = url.path ?: return null
            if (!path.startsWith("/assets/app/")) return null
            val relative = path.removePrefix("/assets/app/").trimStart('/')
            if (relative.split('/').any { it == ".." }) return null
            return try {
                val stream = assets.open("app/$relative")
                WebResourceResponse(mimeTypeFor(relative), null, stream)
            } catch (error: IOException) {
                Log.w(TAG, "asset not found: $relative")
                WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
            }
        }
    }

    private fun mimeTypeFor(path: String): String = when {
        path.endsWith(".html") -> "text/html"
        path.endsWith(".js") -> "text/javascript"
        path.endsWith(".css") -> "text/css"
        path.endsWith(".json") -> "application/json"
        path.endsWith(".map") -> "application/json"
        path.endsWith(".svg") -> "image/svg+xml"
        else -> "application/octet-stream"
    }

    override fun onBackPressed() {
        // Keep navigation inside the web app; exit only from the home screen.
        webView.evaluateJavascript("window.__forgexNavigate && window.__forgexHandleBack && window.__forgexHandleBack()") { handled ->
            if (handled != "true") {
                @Suppress("DEPRECATION")
                super.onBackPressed()
            }
        }
    }

    override fun onDestroy() {
        bridge.shutdown()
        kv.close()
        webView.destroy()
        super.onDestroy()
    }
}
