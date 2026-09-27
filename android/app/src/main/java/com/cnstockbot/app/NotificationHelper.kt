package com.cnstockbot.app

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * 收件箱本地通知（REQ-F7-3）。
 *
 * 设计约束（需求文档审计要点，改动前必读）：
 * - 原生层**不**轮询 /api/inbox——该端点是 drain 语义（读后即删），网页端是唯一
 *   轮询者；原生自行轮询会与网页端抢消息导致聊天窗丢消息；
 * - 原生层**不经手 token**——通知内容全部由网页端桥接转交；
 * - 通知只是"到达提示"，消息本体仍由网页端渲染进聊天窗；本类任何失败路径
 *   （解析失败/权限拒绝/开关关闭）都不得影响聊天主流程。
 */
object NotificationHelper {

    private const val CHANNEL_ID = "inbox"
    private const val PREFS_NAME = "cnstockbot_config"
    private const val KEY_NOTIFY_ENABLED = "notify_enabled"
    private const val KEY_PERMISSION_ASKED = "notify_permission_asked"
    private const val NOTIFICATION_ID = 1

    fun isEnabled(context: Context): Boolean =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getBoolean(KEY_NOTIFY_ENABLED, true)

    fun setEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_NOTIFY_ENABLED, enabled)
            .apply()
    }

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    context.getString(R.string.notify_channel_name),
                    NotificationManager.IMPORTANCE_DEFAULT,
                ),
            )
        }
    }

    /** API 33+ 首次进入主界面时请求一次通知权限；拒绝不影响任何其他功能（F10）。 */
    fun requestPermissionOnce(activity: Activity) {
        if (Build.VERSION.SDK_INT < 33) return
        val prefs = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (prefs.getBoolean(KEY_PERMISSION_ASKED, false)) return
        prefs.edit().putBoolean(KEY_PERMISSION_ASKED, true).apply()
        requestPermission(activity)
    }

    /** 打开通知开关但无权限时重新请求（F11）。 */
    fun requestPermission(activity: Activity) {
        if (Build.VERSION.SDK_INT < 33) return
        activity.requestPermissions(arrayOf("android.permission.POST_NOTIFICATIONS"), 1)
    }

    /** 展示一批收件箱消息的系统通知。任何异常静默丢弃，绝不抛出影响调用方。 */
    fun showInboxNotification(context: Context, messages: List<String>) {
        try {
            if (messages.isEmpty() || !isEnabled(context)) return
            ensureChannel(context)

            val text = if (messages.size == 1) {
                truncate(messages[0])
            } else {
                context.getString(R.string.notify_multi, messages.size, truncate(messages[0]))
            }
            // 展开后展示整批消息（截断防爆），plain text 不解析任何标记
            val bigText = truncate(messages.joinToString("\n"), 400)

            val pending = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context)
            }
            val notification = builder
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(context.getString(R.string.app_name))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(bigText))
                .setContentIntent(pending)
                .setAutoCancel(true)
                .build()
            context.getSystemService(NotificationManager::class.java)
                .notify(NOTIFICATION_ID, notification)
        } catch (e: Exception) {
            Log.w("NotificationHelper", "showInboxNotification failed", e)
        }
    }

    private fun truncate(s: String, max: Int = 80): String {
        val trimmed = s.trim()
        return if (trimmed.length <= max) trimmed else trimmed.take(max) + "…"
    }
}
