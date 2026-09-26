package com.cnstockbot.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import android.widget.TextView

/**
 * WebView 主界面：装载 {服务器}/webchat。
 *
 * 安全基线（对照需求文档 REQ-F7-2 审计要点）：
 * - JS/DOM 存储仅为网页端登录态（localStorage 存 session token）所必需；
 * - file/content 访问关闭；SSL 校验失败一律 cancel，无"继续访问"绕过；
 * - 仅同源 http(s) 链接在 WebView 内打开，其余交系统浏览器。
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var errorView: View
    private lateinit var errorText: TextView
    private var serverUrl: String = ""

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val server = ServerConfigStore.get(this)
        if (server == null) {
            // 防御：配置丢失时回配置页（正常流程由 ServerConfigActivity 拦截）
            startActivity(Intent(this, ServerConfigActivity::class.java))
            finish()
            return
        }
        serverUrl = server

        setContentView(R.layout.activity_main)
        setActionBar(findViewById(R.id.toolbar))

        webView = findViewById(R.id.webview)
        progress = findViewById(R.id.progress)
        errorView = findViewById(R.id.error_view)
        errorText = findViewById(R.id.error_text)
        findViewById<View>(R.id.retry_button).setOnClickListener {
            errorView.visibility = View.GONE
            webView.reload()
        }

        webView.settings.apply {
            javaScriptEnabled = true // 网页端登录/聊天功能所必需
            domStorageEnabled = true // CNStockAuth 的 session token 存 localStorage，硬依赖
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress >= 100) View.GONE else View.VISIBLE
            }
        }

        val serverHost = Uri.parse(serverUrl).host
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                // 新导航开始时隐藏旧错误页
                errorView.visibility = View.GONE
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val isHttp = url.scheme == "http" || url.scheme == "https"
                if (isHttp && url.host.equals(serverHost, ignoreCase = true)) {
                    // 与配置服务器同源：WebView 内继续
                    return false
                }
                // 外部链接（其他域名或 tel/mailto 等 scheme）：交给系统浏览器/应用
                startActivity(Intent(Intent.ACTION_VIEW, url))
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    showError(getString(R.string.error_load, error.description ?: ""))
                }
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                // fail-closed：证书无效一律阻断，不提供绕过入口
                handler.cancel()
                showError(getString(R.string.error_ssl))
            }
        }

        webView.loadUrl("$serverUrl/webchat")
    }

    private fun showError(message: String) {
        errorText.text = message
        errorView.visibility = View.VISIBLE
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        R.id.action_refresh -> {
            errorView.visibility = View.GONE
            webView.reload()
            true
        }
        R.id.action_switch_server -> {
            // 清地址 + 清任务栈重建：旧服务器的一切 WebView 状态（含 localStorage token）随之丢弃
            ServerConfigStore.clear(this)
            val intent = Intent(this, ServerConfigActivity::class.java)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            startActivity(intent)
            true
        }
        R.id.action_about -> {
            val version = try {
                @Suppress("DEPRECATION")
                packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
            } catch (e: Exception) {
                "?"
            }
            AlertDialog.Builder(this)
                .setTitle(R.string.app_name)
                .setMessage(getString(R.string.about_text, version, serverUrl))
                .setPositiveButton(android.R.string.ok, null)
                .show()
            true
        }
        else -> super.onOptionsItemSelected(item)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (this::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
