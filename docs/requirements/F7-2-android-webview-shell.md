# 需求文档：F7-2 安卓 WebView 壳 App

> **文档编号**：REQ-F7-2  
> **对应路线**：F7 安卓端 App → 阶段 2（F7-1 公网可达验证依赖真实公网部署，由部署者
> 按 [deploy/HTTPS.md](../deploy/HTTPS.md) 完成；本需求可在局域网/回环地址上先行开发验证）  
> **依赖**：S4-1 多用户体系 ✅ / S4-2 微服务 token ✅ / S4-3 HTTPS 部署指南 ✅ /
> S4-4 HOST 可配置 ✅  
> **目标读者**：下一个实现 agent / 代码审查 agent / 构建打包者（Android Studio）  
> **状态**：待实现

---

## 1. 背景与目标

### 1.1 背景

项目目标为**公网发布给别人使用**（F7，用户 2026-09-22 指定）。S4 公网发布前置四项
已于 2026-09-26 全部完成，后端已具备多用户注册/登录（session token）与 HTTPS 部署
条件。F7 技术路线选型（见 STATUS.md 第四节）推荐**路线 A：原生 WebView 壳**起步——
现有 `public/` 全部网页（webchat/stocks/market/news/funds/sectors/overseas/scanner/
backtest）零改动全可用，登录/注册已由网页端 `public/shared/auth.js`
（`CNStockAuth`，session token 存 WebView localStorage）完整实现，App 壳不需要
原生重做认证。

### 1.2 目标

- 新建 `android/` 目录：一个**零第三方依赖**的原生 Android WebView 工程
  （纯 Android 框架 + Kotlin），用 Android Studio 打开即可构建 APK；
- 首屏提供**服务端地址配置**（不同部署实例的用户填自己的服务器地址），
  校验并归一化 URL 后进入 WebView 加载 `{服务器}/webchat`；
- WebView 体验基线：加载进度条、返回键按浏览历史回退、加载/证书失败错误页
  （可重试）、外部链接交给系统浏览器、菜单提供刷新/切换服务器；
- 安全基线：**release 构建默认禁止明文 HTTP**（公网必须用 HTTPS，S4-3），
  仅 debug 构建放开明文以便局域网调试；SSL 证书校验失败一律阻断连接（fail-closed）。

### 1.3 非目标（本需求明确不做）

- 原生登录/注册界面：认证由网页端 `CNStockAuth` 完成（App 壳不重做）；
- 本地通知 / 后台轮询 / 推送：属 F7-3 体验加固；
- 应用图标美化、启动屏：属 F7-3（本需求只给可构建的最小自适应图标）；
- TWA/Bubblewrap 打包、Play 上架、Digital Asset Links；
- Capacitor 混合应用升级（路线 B 留待 F7-3 评估）；
- 指纹/生物识别登录：F7-3 可选项；
- 对 `src/`、`public/`、data-service 的任何改动（壳是纯新增目录）。

---

## 2. 用户故事

- **US-1（新用户）**：首次打开 App，输入朋友给我的服务器地址（如
  `https://stock.example.com`），点"保存并进入"，看到网页端登录页，注册账号后
  正常使用全部功能。
- **US-2（老用户）**：App 记住上次的服务器地址，打开直接进入聊天页；想换服务器
  时点菜单"切换服务器"重新配置。
- **US-3（局域网调试者）**：debug 包允许填 `http://192.168.x.x:18790` 调试；
  release 包拒绝明文地址并提示改用 HTTPS。
- **US-4（安全）**：服务器证书无效时 App 阻断连接并明确提示，不提供"继续访问"绕过。

---

## 3. 功能需求

### 3.1 服务端地址配置（首屏）

| # | 需求 |
|---|---|
| F1 | 首次启动（或切换服务器）展示配置页：地址输入框 + 说明文案 + "保存并进入"按钮 |
| F2 | 地址校验：允许 http/https；缺协议时默认补 `https://`；仅取协议+主机[:端口]，自动剥离路径/参数/尾斜杠 |
| F3 | 输入为空或格式非法 → 输入框下方红字提示，不保存 |
| F4 | release 构建输入 `http://` 地址 → 拒绝保存并提示"正式版仅支持 HTTPS，调试请使用 debug 包" |
| F5 | 合法地址持久化到 SharedPreferences，之后启动直接进入 WebView |
| F6 | 配置页展示当前版本号，便于用户报障时核对 |

### 3.2 WebView 主界面

| # | 需求 |
|---|---|
| F7 | 加载 `{服务器}/webchat`；未登录用户由网页端呈现登录/注册卡片（现有行为，壳不干预） |
| F8 | WebView 设置：`javaScriptEnabled=true`、`domStorageEnabled=true`（localStorage 存 session token 的硬依赖）、`allowFileAccess=false`、`allowContentAccess=false`、`mediaPlaybackRequiresUserGesture=true` |
| F9 | 顶部水平进度条，按 `onProgressChanged` 显示/隐藏 |
| F10 | 返回键：`canGoBack()` 为真时回退历史，否则按系统默认（退出到桌面） |
| F11 | `shouldOverrideUrlLoading`：http(s) 且与配置服务器同源的链接在 WebView 内打开；其余 scheme（tel/mailto/外部域名 http 链接等）交 `Intent` 给系统浏览器 |
| F12 | 加载失败（无网络/5xx/超时）→ 错误页（说明 + "重试"按钮），不显示浏览器默认错误页 |
| F13 | `onReceivedSslError` → 一律 `handler.cancel()` 并显示证书错误页（文案说明可能的原因），**不提供继续访问** |
| F14 | 菜单三项：刷新 / 切换服务器（清地址回配置页，WebView 历史随之重置）/ 关于（显示版本与服务器地址） |

### 3.3 构建与工程

| # | 需求 |
|---|---|
| F15 | `android/` 为独立 Gradle 工程（settings.gradle.kts + build.gradle.kts + app 模块），applicationId `com.cnstockbot.app`，minSdk 24，target/compileSdk 34，零第三方库依赖 |
| F16 | Kotlin 语言；AGP 8.5.x + Kotlin 1.9.x；Android Studio 较新版本打开可直接 Sync |
| F17 | 最小自适应启动图标（vector foreground + 纯色背景），不依赖 PNG 素材 |
| F18 | release 构建 `usesCleartextTraffic=false`；debug 构建经 debug 专属 manifest 放开明文 |
| F19 | `android/README.md`：构建步骤（Android Studio 打开 → Sync → Build APK）、真机安装方法、地址配置说明、release/debug 差异、与 F7-3 的衔接 |

---

## 4. 非功能需求

- **安全**：WebView 不开启 file/content 访问；SSL fail-closed（F13）；release 禁明文（F18）；
  服务器地址仅存本机 SharedPreferences（私有模式）。
- **兼容**：minSdk 24（Android 7.0）覆盖绝大多数在役设备；targetSdk 34。
- **可维护**：壳内代码仅做"地址配置 + WebView 装载"，不内嵌业务逻辑；业务迭代仍在
  网页端，App 免发版。
- **可验证（本机约束）**：开发机无 Android SDK/Gradle，本需求的验证以
  XML 合法性解析 + 工程文件齐全性 + 配置自洽（applicationId/包名/资源引用一致）
  为准；APK 构建与真机验收由构建者在 Android Studio 中执行（在汇报与 PR 中明确
  写明"构建验证未做及原因"）。

---

## 5. 数据与 API 改动

无。App 壳仅消费现有端点：

- 静态页：`GET /webchat`（及网页内导航跳转的 /stocks、/market 等，均不鉴权）；
- 认证：`/api/auth/register|login|logout`（由网页端 `auth.js` 调用，壳不经手 token）；
- 业务 API：全部由网页端 `CNStockAuth.apiFetch` 带 Bearer 调用（壳不经手）。

## 6. 验收标准

1. Android Studio 打开 `android/`，Sync 成功，Build APK 无报错；
2. 真机安装 debug 包：填局域网 `http://<PC-IP>:18790` 可进入聊天页并完成注册/登录/对话；
3. 杀掉 App 重开：记住地址直接进入，登录态仍在（localStorage 持久）；
4. 返回键按浏览历史回退；断网时显示错误页，恢复后重试成功；
5. release 包填 `http://` 地址被 F4 拒绝；填 HTTPS 地址正常；
6. 面对证书无效的服务器（如自签名），App 阻断并提示，无绕过入口；
7. `npm run typecheck` + `npm test` 保持全绿（本需求不动主服务代码）。

## 7. 审计要点

- 地址归一化是否有注入/越权面（仅作 loadUrl 目标，经 `Uri` 解析后只取 scheme+authority）；
- WebView 设置逐项核对 F8 白名单，不得出现 `setJavaScriptEnabled` 之外的过度放开
  （尤其 `allowFileAccess` 必须为 false）；
- SSL fail-closed 是否可被用户绕过（不得出现 `handler.proceed()`）；
- release/debug 明文策略是否仅靠 manifest 分层实现，release 主 manifest 必须
  `usesCleartextTraffic=false`；
- 菜单"切换服务器"是否真的重置了 WebView 状态（防止旧服务器 token 串到新服务器）。
