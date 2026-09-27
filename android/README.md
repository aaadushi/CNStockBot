# CNStockBot 安卓 App（F7-2 WebView 壳 + F7-3 本地通知/启动屏）

本目录是独立的 Android 工程：**原生 WebView 壳 + 首屏服务器地址配置 +
收件箱本地通知 + 品牌启动屏**。壳内不做任何业务逻辑——登录/注册/聊天/行情
全部由网页端 `CNStockAuth` 完成，session token 存 WebView localStorage；
通知内容也全部由网页端桥接转交（原生层不轮询 `/api/inbox`、不经手 token）。

- 需求文档：[F7-2](../docs/requirements/F7-2-android-webview-shell.md) /
  [F7-3](../docs/requirements/F7-3-app-experience.md)
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
3. 右上角菜单：新通知（开关，默认开）/ 刷新 / 切换服务器 / 关于；
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

## 国内网络注意事项

工程已自带 **Gradle Wrapper**（`gradle/wrapper/`，锁定 Gradle 8.7），且
`distributionUrl` 指向腾讯镜像 `mirrors.cloud.tencent.com`——Android Studio 打开工程
会直接按 wrapper 配置下载，**无需手动设置 Gradle**。

- `settings.gradle.kts` 已把 Maven 源配成**阿里云镜像优先、官方源兜底**（AGP/Kotlin 插件
  与依赖库走 maven.aliyun.com）；
- SDK 组件下载失败：`Settings → SDK Update Sites` 添加
  `https://mirrors.cloud.tencent.com/AndroidSDK/`。

## 本地通知（F7-3）

App 在前台时，网页端收件箱轮询（30s）drain 到收盘日报/异动提醒等消息会
同时弹系统通知（单条显示摘要，多条显示条数 + 首条摘要；点通知回到聊天页，
消息全文已在聊天窗内）。菜单"新通知"可整体关闭（本机偏好，与服务器无关）。
Android 13+ 首次进入主界面会请求通知权限，拒绝不影响任何其他功能。

**边界**：App 后台/被杀期间不弹通知（可靠后台需厂商推送通道，维持不作
首版目标的既定决策）；期间到达的消息不丢，回到前台照常进聊天窗并弹通知。

## 后续（F7-1，依赖部署者）

公网部署后端到端验证（域名 + 反向代理 + 证书，按
[docs/deploy/HTTPS.md](../docs/deploy/HTTPS.md)）；生物识别登录与路线 B
（Capacitor）经 REQ-F7-3 评估明确不做。
