package com.cnstockbot.app

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView

/**
 * 首屏：服务器地址配置。
 * - 已保存地址 → 直接进 MainActivity（本页不渲染）；
 * - 未保存 → 表单：输入、校验（F2/F3/F4）、持久化后进入 WebView。
 */
class ServerConfigActivity : Activity() {

    private lateinit var input: EditText
    private lateinit var errorText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ServerConfigStore.get(this)?.let { saved ->
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }
        setContentView(R.layout.activity_server_config)

        input = findViewById(R.id.server_input)
        errorText = findViewById(R.id.error_text)
        findViewById<Button>(R.id.save_button).setOnClickListener { save() }
        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) {
                save()
                true
            } else {
                false
            }
        }

        findViewById<TextView>(R.id.version_text).text =
            getString(R.string.config_version, versionName())
    }

    private fun save() {
        val url = ServerUrl.normalize(input.text.toString())
        if (url == null) {
            showError(getString(R.string.config_error_invalid))
            return
        }
        // F4：release 构建拒绝明文 HTTP；仅 debug 包允许（配合 debug manifest 的明文放开）
        val isDebuggable = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        if (url.startsWith("http://") && !isDebuggable) {
            showError(getString(R.string.config_error_http))
            return
        }
        errorText.visibility = View.GONE
        ServerConfigStore.set(this, url)
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun showError(message: String) {
        errorText.text = message
        errorText.visibility = View.VISIBLE
    }

    private fun versionName(): String = try {
        @Suppress("DEPRECATION")
        packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
    } catch (e: Exception) {
        "?"
    }
}
