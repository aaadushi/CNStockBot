package com.cnstockbot.app

import android.content.Context
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray

/**
 * 网页端 → 原生桥（REQ-F7-3 F1/F5），注入名 CNStockAndroid。
 *
 * 攻击面控制（需求文档审计要点）：本桥只暴露"弹通知"一个无副作用能力——
 * 不读文件、不取 token、不发网络请求。WebView 只装载用户配置的服务器页面，
 * 外部链接一律外抛系统浏览器，同 F7-2 基线。
 */
class AndroidBridge(private val context: Context) {

    /** 网页端收件箱轮询 drain 到消息后，把整批消息原文转交（JSON 字符串数组）。 */
    @JavascriptInterface
    fun onInboxMessages(json: String) {
        try {
            val array = JSONArray(json)
            val messages = (0 until array.length())
                .map { array.optString(it) }
                .filter { it.isNotBlank() }
            NotificationHelper.showInboxNotification(context, messages)
        } catch (e: Exception) {
            // 解析失败静默丢弃：通知只是提示，绝不能影响聊天主流程
            Log.w("AndroidBridge", "onInboxMessages parse failed", e)
        }
    }
}
