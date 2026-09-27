# 需求文档：F7-3 安卓 App 体验加固（本地通知 + 启动屏）

> **文档编号**：REQ-F7-3  
> **对应路线**：F7 安卓端 App → 阶段 3（体验加固）。F7-1 公网部署端到端验证依赖真实
> 域名 + 反向代理 + 证书（由部署者按 [deploy/HTTPS.md](../deploy/HTTPS.md) 执行），不在本需求内。  
> **依赖**：F7-2 安卓 WebView 壳 ✅（工程与真机构建链路已就绪）  
> **目标读者**：下一个实现 agent / 代码审查 agent / 构建打包者（Android Studio）  
> **状态**：已实现（2026-09-27）

---

## 1. 背景与目标

### 1.1 背景

F7-2 壳工程完成后，App 已能装载网页端全部功能，但有一个明显体验缺口：
**收盘日报、异动提醒等离线通知只在用户打开 App 且停留在聊天页时才可见**——
网页端每 30s 轮询 `GET /api/inbox`（drain 语义，读后即删），消息被渲染进聊天窗。
用户切到后台或没开 App 时，系统通知栏没有任何提示。

STATUS.md 对推送口径的既定决策：**原生推送（FCM 国内不可用、厂商通道接入重）不作
首版目标；"App 内轮询 + 本地通知"是性价比最高的中间态**。本需求落地这个中间态。

### 1.2 目标

- 收件箱消息到达聊天页的同时，**在系统通知栏弹出本地通知**（单条显示摘要，多条
  显示条数 + 首条摘要）；点通知回到 App（消息已在聊天窗内，无数据丢失）；
- 菜单提供**通知开关**（持久化，默认开）；
- **启动屏**：windowBackground 品牌启动画面（indigo 底 + 居中走势图 Logo）；
- 保持 F7-2 的全部安全基线（SSL fail-closed、release 禁明文、零第三方依赖）。

### 1.3 非目标（本需求明确不做）

- **真后台轮询 / 杀进程后收通知**：Android Doze 与应用待机会挂起 WebView 的 JS
  定时器，可靠后台轮询需要前台服务 + native 持有 token + 非破坏性 peek 端点，
  与 F7-2"壳不经手 token"的安全口径冲突；厂商推送通道（FCM 国内不可用、
  小米/华为通道接入重）维持 STATUS 既定决策**不作首版目标**。通知覆盖范围 =
  **App 在前台（网页轮询存活）期间**；后台期间到达的通知在下次回到前台时
  照常 drain 进聊天窗并弹通知，不丢消息（drain 语义 + SQLite 持久化保证）。
- **生物识别/指纹登录**：STATUS 中标注"可选"。官方 BiometricPrompt 依赖
  androidx.biometric，破坏 F7-2 零第三方依赖基线；框架 FingerprintManager 自
  API 28 起废弃且不支持人脸。且威胁模型收益低——session token 本就持久化在
  WebView localStorage，拿到已解锁手机的人不经过指纹也能直接用 App。
  **结论：不做**，如未来要做单独立项评估 androidx.biometric 引入成本。
- **路线 B（Capacitor 混合应用）升级**：评估结论**不升级**——本需求用原生
  JS Bridge 已覆盖"本地通知"这一路线 B 的核心诉求；Capacitor 会引入 Node
  工具链与插件生态，把纯静态网页的迭代流程变成双端构建，成本远大于收益。
- 应用图标重设计（F7-2 最小自适应图标沿用；本需求新增启动屏与通知栏图标）；
- 对 `src/`、data-service 的任何改动；后端 API 零改动。

---

## 2. 用户故事

- **US-1（持仓用户）**：App 开着放在桌上，15:30 收盘日报到达 → 通知栏弹出
  "股助手：收盘日报…"，点通知回到聊天页看全文。
- **US-2（通知嫌吵的用户）**：菜单里关掉"新通知"，之后收件箱消息只进聊天窗
  不弹通知；随时可再打开。
- **US-3（权限谨慎的用户）**：Android 13+ 首次进入主界面时被请求通知权限，
  拒绝后 App 功能不受任何影响（只是不弹通知），之后打开开关会再次请求。
- **US-4（升级用户）**：覆盖安装后服务器地址、登录态（localStorage）不受影响；
  启动时看到品牌启动画面而非白屏。

---

## 3. 功能需求

### 3.1 网页端 → 原生桥接（public/webchat/index.html）

| # | 需求 |
|---|---|
| F1 | 收件箱轮询（现有 30s `apiFetch('/api/inbox')`）drain 到消息后，除现有 `addMsg` 渲染外，若 `window.CNStockAndroid` 存在则调用 `CNStockAndroid.onInboxMessages(JSON.stringify(messages))` 把整批消息原文转交原生层 |
| F2 | 桥接调用包 try/catch：壳桥接不存在或抛错时**绝不影响**聊天渲染与轮询主流程 |
| F3 | 未登录（轮询本就不发请求）、无新消息、纯浏览器访问（无桥）三种情况均不调用桥 |
| F4 | 网页端不为此新增任何 UI；浏览器端行为零变化 |

**设计约束（实现与审计必须遵守）**：`/api/inbox` 是 drain 语义，**网页端是唯一
轮询者**。原生层不得自行轮询该端点（否则与网页端抢消息，聊天窗丢消息）。
原生层也不接触 token——桥只接收网页已经 drain 到的消息文本。

### 3.2 原生通知（android/）

| # | 需求 |
|---|---|
| F5 | `AndroidBridge`（`@JavascriptInterface`，注入名 `CNStockAndroid`）暴露 `onInboxMessages(json: String)`；解析失败静默丢弃，不崩溃 |
| F6 | 通知渠道（API 26+）`inbox`，IMPORTANCE_DEFAULT；渠道名对用户可见 |
| F7 | 通知内容：1 条 → 标题"股助手"、正文为消息文本（超长截断）；N 条 → 正文"N 条新通知"+ 首条摘要。全部 plain text，不解析 HTML |
| F8 | 通知小图标为专用 vector drawable（白色走势图 glyph），不使用自适应图标 |
| F9 | 点通知 → PendingIntent 拉起 MainActivity（launchMode singleTop，不产生重复实例）；不携带额外数据（聊天窗已有消息全文） |
| F10 | Android 13+（API 33+）首次进入主界面请求 `POST_NOTIFICATIONS` 运行时权限；用户拒绝不影响任何其他功能 |
| F11 | 通知开关：菜单新增可勾选项"新通知"，默认开，持久化 SharedPreferences；关闭时桥接消息照常进聊天窗但不弹通知；打开时若无权限则重新请求权限 |
| F12 | "切换服务器"重置 WebView 时**不清除**通知开关偏好（与服务器无关的本机偏好） |

### 3.3 启动屏与图标

| # | 需求 |
|---|---|
| F13 | `windowBackground` 改为 layer-list：indigo 纯色底 + 居中 `ic_launcher_foreground`（白色走势图 glyph，尺寸 96dp）；minSdk 24 支持 layer-list item 的 width/height |
| F14 | 主主题（两个 Activity 共用）统一生效；启动画面在页面首帧渲染前显示，不引入启动延迟 hack |
| F15 | 版本号升级：versionCode 2 / versionName 0.2.0 |

### 3.4 网页契约回归测试

| # | 需求 |
|---|---|
| F16 | 新增 vitest 用例守护 F1 契约：webchat/index.html 的收件箱轮询代码必须包含 `CNStockAndroid` 桥调用与 try/catch 保护，防后续重构把桥接改丢 |

---

## 4. 非功能需求

- **安全基线不回退**：`addJavascriptInterface` 是本需求唯一新增攻击面——桥对象
  只暴露"弹通知"一个无副作用能力，不读文件、不取 token、不做网络请求；WebView
  其余设置（file/content 关闭、SSL fail-closed、外部链接外抛）逐项保持 F7-2 原样；
- **零第三方依赖不回退**：通知、权限、JSON（org.json）全部用框架 API；
- **不丢消息**：通知只是"到达提示"，消息本体仍由网页端 drain 渲染进聊天窗，
  通知开关、权限拒绝、桥接异常都不影响消息进聊天窗；
- **可验证（本机约束）**：同 F7-2——开发机无 Android SDK，验证以 XML 合法性 +
  工程自洽 + 主服务 `npm run typecheck`/`npm test` 全绿为准；APK 构建与真机
  验收（通知弹出、权限弹窗、启动屏、开关）由构建者在 Android Studio 执行。

---

## 5. 数据与 API 改动

- 后端：零改动，零新端点。
- 网页端：`public/webchat/index.html` 收件箱轮询处新增桥接调用（F1~F3，约 5 行）。
- App：`android/` 内新增 `AndroidBridge.kt` / `NotificationHelper.kt`、通知图标与
  启动屏 drawable、菜单项、manifest 权限与 launchMode、strings/themes 更新。

---

## 6. 验收标准

1. Android Studio 打开 `android/`，Sync 成功，Build APK 无报错；
2. 真机（Android 13+ 与一台低版本设备各一）：登录后让服务端产生一条收件箱通知
   （如加自选后等收盘日报，或手动 `pushInbox`）→ 通知栏弹出本地通知，点通知
   回到聊天页且消息已在聊天窗内；
3. 多条通知同批到达 → 通知显示"N 条新通知"+ 首条摘要；
4. 菜单关闭"新通知"→ 消息照常进聊天窗、不弹通知；重开 App 开关状态保持；
5. Android 13+ 拒绝通知权限 → App 其余功能全部正常，无崩溃；
6. 冷启动 → 显示 indigo 启动画面（Logo 居中），无白屏闪烁；
7. 覆盖安装（同签名）→ 服务器地址与登录态保留；
8. `npm run typecheck` + `npm test` 全绿（含 F16 新增契约用例）。

---

## 7. 审计要点

- 桥接契约：网页端是否只在 drain 到消息后调用桥、是否 try/catch 兜底；
  原生层是否**没有**自行 fetch `/api/inbox`、是否**没有**接触 token；
- `addJavascriptInterface` 暴露面：桥方法是否仅弹通知，无文件/网络/账号能力；
- 通知权限：是否仅在 API 33+ 请求；拒绝路径是否不崩溃、不反复骚扰（仅首次 +
  打开开关时请求）；
- drain 语义防回归：通知开关关闭/权限拒绝/桥异常时，消息是否仍照常进聊天窗；
- 安全基线 diff：manifest 新增仅 `POST_NOTIFICATIONS` 与 MainActivity
  `launchMode="singleTop"`，`usesCleartextTraffic` 分层策略不得改动；
- 通知文本一律 plain text，不得对消息内容做任何 HTML/样式解析。
