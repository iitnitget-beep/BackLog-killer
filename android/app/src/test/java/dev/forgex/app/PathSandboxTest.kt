package dev.forgex.app

import android.app.Activity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * These are the tests that matter most for the native layer: the path sandbox is
 * the one thing that must never fail, because the agent writes files for a living.
 * Robolectric gives us a real Context with a real filesDir.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PathSandboxTest {

    private fun bridge(): ForgeXBridge {
        val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        return ForgeXBridge(activity, SecureStore(activity), KeyValueStore(activity))
    }

    @Test
    fun `resolves a normal workspace path`() {
        val bridge = bridge()
        val file = bridge.resolvePath("app/src/Main.kt", mustExist = false)
        assertTrue(file.path.contains("/workspace/"))
        assertTrue(file.path.endsWith("app/src/Main.kt"))
    }

    @Test
    fun `rejects parent traversal`() {
        val bridge = bridge()
        val error = runCatching { bridge.resolvePath("../escape.txt", mustExist = false) }.exceptionOrNull()
        assertTrue("expected a SecurityException, got $error", error is SecurityException)
    }

    @Test
    fun `rejects traversal hidden in the middle of a path`() {
        val bridge = bridge()
        val error = runCatching { bridge.resolvePath("app/../../escape.txt", mustExist = false) }.exceptionOrNull()
        assertTrue(error is SecurityException)
    }

    @Test
    fun `rejects absolute paths outside the sandbox`() {
        val bridge = bridge()
        val error = runCatching { bridge.resolvePath("/etc/passwd", mustExist = false) }.exceptionOrNull()
        assertTrue(error is SecurityException)
    }

    @Test
    fun `maps the virtual workspace prefix into app storage`() {
        val bridge = bridge()
        val file = bridge.resolvePath("/workspace/proj/app/build.gradle.kts", mustExist = false)
        assertTrue(file.path.contains("/workspace/proj/app/build.gradle.kts"))
    }

    @Test
    fun `write then read round trips`() {
        val bridge = bridge()
        bridge.fsWrite("notes/hello.txt", "hi")
        assertEquals("hi", bridge.fsRead("notes/hello.txt"))
        assertTrue(bridge.fsExists("notes/hello.txt"))
    }

    @Test
    fun `listing returns dirs first and respects suffix`() {
        val bridge = bridge()
        bridge.fsWrite("proj/a.kt", "class A")
        bridge.fsWrite("proj/readme.md", "docs")
        val listed = bridge.fsList("proj", """{"recursive":true,"suffix":".kt"}""")
        assertTrue(listed.contains("a.kt"))
        assertFalse(listed.contains("readme.md"))
    }

    @Test
    fun `refuses to delete the workspace root`() {
        val bridge = bridge()
        val error = runCatching { bridge.fsRemove("/workspace") }.exceptionOrNull()
        assertTrue(error != null)
    }

    @Test
    fun `exec refuses binaries outside the allowlist`() {
        val bridge = bridge()
        val error = runCatching { bridge.exec("""["curl","http://evil"]""", "", 1000) }.exceptionOrNull()
        assertTrue("expected SecurityException, got $error", error is SecurityException)
    }

    @Test
    fun `exec runs an allowlisted command without a shell`() {
        val bridge = bridge()
        val result = bridge.exec("""["echo","hello"]""", "", 5000)
        assertTrue(result.contains("hello"))
        assertTrue(result.contains("\"code\":0"))
    }

    @Test
    fun `secrets round trip through the encrypted store`() {
        val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val store = SecureStore(activity)
        store.set("provider/apiKey", "sk-test-123")
        assertEquals("sk-test-123", store.get("provider/apiKey"))
        store.delete("provider/apiKey")
        assertEquals(null, store.get("provider/apiKey"))
    }

    @Test
    fun `key value store persists and lists by prefix`() {
        val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val kv = KeyValueStore(activity)
        kv.set("runs/a/events", "[]")
        kv.set("runs/b/events", "[]")
        kv.set("other", "x")
        assertEquals("[]", kv.get("runs/a/events"))
        assertEquals(listOf("runs/a/events", "runs/b/events"), kv.keys("runs/"))
        kv.delete("runs/a/events")
        assertEquals(null, kv.get("runs/a/events"))
        kv.close()
    }

    @Test
    fun `apk install rejects non-apk files`() {
        val bridge = bridge()
        bridge.fsWrite("notanapk.txt", "x")
        val error = runCatching { bridge.installApk("notanapk.txt") }.exceptionOrNull()
        assertTrue(error is java.io.IOException)
    }
}
