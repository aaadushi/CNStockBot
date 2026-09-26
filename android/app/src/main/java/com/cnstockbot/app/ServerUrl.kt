package com.cnstockbot.app

import android.net.Uri

/**
 * 服务器地址归一化（纯函数，便于审查与对照需求文档 REQ-F7-2 3.1-F2/F3）：
 * - 允许用户粘贴完整 URL，只保留 scheme + authority（剥离路径/参数/尾斜杠）；
 * - 缺协议时默认补 https://；
 * - 任何一步解析不出 scheme/host 即判非法（返回 null），由配置页提示用户。
 *
 * 返回结果只用于 WebView loadUrl 目标，不做任何字符串拼接进可执行上下文。
 */
object ServerUrl {
    fun normalize(raw: String): String? {
        var s = raw.trim()
        if (s.isEmpty()) return null
        if (!s.startsWith("http://", ignoreCase = true) &&
            !s.startsWith("https://", ignoreCase = true)
        ) {
            s = "https://$s"
        }
        val uri = Uri.parse(s) ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = uri.host ?: return null
        if (host.isBlank()) return null
        // 去掉域名末尾的点（FQDN 写法归一），避免同源判断出现双写问题
        val normalizedHost = host.removeSuffix(".")
        val port = uri.port
        val defaultPort = (scheme == "http" && port == 80) || (scheme == "https" && port == 443)
        val authority = if (port == -1 || defaultPort) normalizedHost else "$normalizedHost:$port"
        return "$scheme://$authority"
    }
}
