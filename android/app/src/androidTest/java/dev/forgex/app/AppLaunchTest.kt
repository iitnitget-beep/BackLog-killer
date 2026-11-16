package dev.forgex.app

import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withClassName
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.hamcrest.Matchers.containsString
import org.junit.Test
import org.junit.runner.RunWith

/**
 * M1 acceptance: the app launches and the WebView shell is on screen.
 *
 * This is a *host* test of the activity lifecycle; asserting on web content
 * needs the assets bundle present, which CI guarantees by building it first.
 */
@RunWith(AndroidJUnit4::class)
class AppLaunchTest {
    @Test
    fun activityLaunchesWithWebView() {
        ActivityScenario.launch(MainActivity::class.java).use {
            onView(withClassName(containsString("WebView"))).check(matches(isDisplayed()))
        }
    }
}
