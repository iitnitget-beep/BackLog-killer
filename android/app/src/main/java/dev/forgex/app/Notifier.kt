package dev.forgex.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** Local notifications for "build finished" / "build failed". Fails soft. */
class Notifier(private val context: Context) {
    companion object {
        private const val TAG = "ForgeXNotifier"
        private const val CHANNEL_ID = "forgex_runs"
        private const val NOTIFICATION_ID = 1001
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "ForgeX runs", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Build progress and results"
            },
        )
    }

    fun show(title: String, body: String) {
        try {
            ensureChannel()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                Log.i(TAG, "notification permission not granted; skipping")
                return
            }
            val notification = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .build()
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
        } catch (error: Exception) {
            Log.w(TAG, "notify failed", error)
        }
    }
}
