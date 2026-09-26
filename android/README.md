# CNStockBot 安卓 App（F7-2：WebView 壳）

本目录是独立的 Android 工程：**原生 WebView 壳 + 首屏服务器地址配置**，
包装现有网页端（`public/` 全部页面零改动）。壳内不做任何业务逻辑——
登录/注册/聊天/行情全部由网页端 `CNStockAuth` 完成，session token 存 WebView
localStorage。

- 需求文档：[docs/requirements/F7-2-android-webview-shell.md](../docs/requirements/F7-2-android-webview-shell.md)
- 应用 ID：`com.cnstockbot.app`（debug 包为 `com.cnstockbot.app.debug`）
- minSdk 24 / targetSdk 34，Kotlin，**零第三方依赖**（不含 androidx，任何较新版本 Android Studio 均可 Sync）

## 构建 APK

1. 用 Android Studio（建议 Hedgehog 及以上，自带 JDK 17）打开本 `android/` 目录；
2. 等待 Gradle Sync 完成（会自动下载 AGP 8.5.2 + Kotlin 1.9.24）；
3. `Build → Build Bundle(s) / APK(s) → Build APK(s)`：
   - 选 `debug` 构建变体 → 输出 `app-debug.apk`（允许明文 HTTP，供局域网调试）；
   - 选 `release` 构建变体 → 输出 `app-release.apk`（仅 HTTPS，正式分发用）。

命令行方式（需本机装有 Android SDK 与 Gradle 8.7+）：

```bash
cd android
gradle assembleDebug      # 或 assembleRelease
```

## 安装与使用

```bash
adb install app/build/outputs/apk/debug/app-debug.apk
```

1. 首次打开 → 输入服务器地址（如 `https://stock.example.com`，或调试时
   `http://192.168.x.x:18790`），点"保存并进入"；
2. 看到网页端登录卡片 → 注册/登录后正常使用全部功能；
3. 右上角菜单：刷新 / 切换服务器 / 关于；
4. 返回键按浏览历史回退。

## release 与 debug 的差异

| 项 | release | debug |
|---|---|---|
| 明文 HTTP | **禁止**（manifest `usesCleartextTraffic=false`） | 允许（`src/debug/AndroidManifest.xml` 单独放开） |
| 应用 ID | `com.cnstockbot.app` | `com.cnstockbot.app.debug`（可与 release 共存） |
| 用途 | 公网正式发布 | 局域网/回环调试 |

## 安全设计（审查要点）

- SSL 证书校验失败**一律阻断**（`onReceivedSslError → handler.cancel()`），无继续访问入口；
- WebView 关闭 file/content 访问；JS 与 DOM 存储仅为网页端登录态所必需；
- 与配置服务器不同源的链接一律交系统浏览器，不在 WebView 内打开；
- 服务器地址仅存本机私有 SharedPreferences；"切换服务器"清地址并重建任务栈，
  旧服务器残留状态（含 token）随之丢弃。

## 后续（F7-3，未做）

本地通知（收盘日报/异动提醒落地为系统通知）、后台轮询收件箱、应用图标与启动屏、
生物识别登录；以及从路线 A 升级到路线 B（Capacitor）的评估。
