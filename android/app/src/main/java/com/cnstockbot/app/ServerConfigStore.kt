package com.cnstockbot.app

import android.content.Context

/**
 * 服务器地址的本地持久化（私有 SharedPreferences）。
 * 地址仅存本机，不随备份以外的方式外泄；切换服务器时 clear() 使旧服务器 token 不再被使用。
 */
object ServerConfigStore {
    private const val PREFS_NAME = "cnstockbot_config"
    private const val KEY_SERVER_URL = "server_url"

    fun get(context: Context): String? =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_SERVER_URL, null)

    fun set(context: Context, url: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SERVER_URL, url)
            .apply()
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_SERVER_URL)
            .apply()
    }
}
