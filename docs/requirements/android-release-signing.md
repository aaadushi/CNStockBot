# REQ-Android-Release-Signing：release 签名密钥生成与工程接入

> 需求文档（2026-10-10 建立）。本任务源自 STATUS 更新日志批次 31/32 待办
> "release 签名密钥生成（公网分发前）"，是 F7 安卓端公网分发 APK 的签名基础。
> 关联：[F7-2](F7-2-android-webview-shell.md) / [F7-3](F7-3-app-experience.md) /
> [android/README.md](../../android/README.md)。

## 背景与目标

android/ 工程的 release 构建变体目前**未配置签名**，`assembleRelease` 产出的是
未签名 APK，无法对外分发（Android 要求所有 APK 必须签名才能安装）。
公网发布是 F7 的既定目标，签名密钥是公网分发的**硬前置**——且密钥生成越早越好：
密钥是长期资产，后续所有正式版的升级覆盖安装都以同一密钥签名为前提，
密钥丢失 = 永远无法再覆盖安装已发布的应用。

**目标**：用 keytool 生成 release 签名密钥，接入 android/ 工程 Gradle 配置，
使 release 构建变体在密钥库存在时自动产出**已签名** APK；
密钥与密码文件**绝不入库**（审计红线）。

## 范围

### 做

1. **生成密钥库**：`keytool -genkeypair`，参数：
   - keystore：`android/keystore/cnstockbot-release.jks`
   - alias：`cnstockbot_release`
   - keyalg：RSA，keysize：3072，validity：10000 天
   - storepass / keypass：强随机密码（本机生成，两密码相同为 Android 常规做法，
     文档说明）
   - dname：CN 等字段用 CNStockBot / CN 合理值
2. **属性文件** `android/keystore/keystore.properties`：存
   `storeFile` / `storePassword` / `keyAlias` / `keyPassword` 四键（properties 格式）。
3. **.gitignore**：`android/keystore/` 整个目录加入根 `.gitignore`，
   提交前 `git status` 核验密钥库与属性文件均为被忽略状态。
4. **Gradle 接入**（`android/app/build.gradle.kts`）：**仅当**
   keystore.properties 存在时读取并创建 `signingConfigs["release"]` 绑定到
   `buildTypes.release`；文件不存在时 release 保持不签名（现状行为，不得 fail）。
   不得破坏 debug 变体现状（debug 继续走 Android 默认 debug 签名）。
5. **文档**：`android/README.md` 补充 release 签名说明（机制 + 备份警告）；
   `docs/STATUS.md` 更新日志加批次记录，并把批次 31/32 待办
   "release 签名密钥生成（公网分发前）"标为已完成。

### 不做（明确排除）

- **不构建 APK**：本机无 Android SDK，assembleRelease 的实际构建验证留给
  Android Studio 持有者（`gradlew assembleRelease` 或 Studio Sync）。
- **不接 CI / 不做自动构建流水线**（本工程无 CI 基础设施）。
- **不上架应用商店**（Google Play / 国内商店均不在范围，仅侧载分发准备）。
- **不改动 debug 签名现状**（debug 仍用默认 debug keystore）。
- **不动 App 原生代码 / manifest / 任何 Kotlin、XML 文件**（纯构建配置改动）。
- **不做密钥托管/加密方案**（keystore.properties 明文存本机是 Android 官方
  推荐的本机开发模式；仅保证不进版本库）。
- 公网部署本身（F7-1）不在本次范围。

## 密钥参数与存放策略

| 项 | 值 |
|---|---|
| 密钥库路径 | `android/keystore/cnstockbot-release.jks`（相对 android/ 工程根） |
| key alias | `cnstockbot_release` |
| 算法 / 密钥长度 | RSA 3072 |
| 有效期 | 10000 天（约 27 年，远超应用生命周期，Google 推荐上限内） |
| 签名方案 | APK 默认（v2+ 由 AGP 决定，targetSdk 34 下自动启用 v2/v3） |
| storepass / keypass | 相同（Android 常规做法；两密码不同在部分构建链上徒增复杂度） |
| 存放 | 仅本机文件系统，**绝不进版本库** |

**备份义务**：`android/keystore/` 整个目录（.jks + keystore.properties）是
发布者唯一资产，换机器/重装系统/换开发者前必须整体备份到安全介质；
Android 签名密钥丢失 = 无法覆盖安装已发布应用，只能换应用 ID 重新发布。

## Gradle 配置方案（KTS）

在 `android/app/build.gradle.kts` 中：

1. 文件顶部（`android {}` 之前）：检测 `rootProject.file("keystore/keystore.properties")`
   是否存在，存在则 `Properties()` 加载（非交互 keytool 等场景下的本机文件，
   读取失败静默降级为"不签名"）。
2. `android {}` 内新增 `signingConfigs` 块：仅当 properties 非空时创建
   `create("release")`，storeFile 指向 `rootProject.file(props["storeFile"])`。
3. `buildTypes.release` 中：`if (signingConfigs.findByName("release") != null)
   signingConfig = signingConfigs.getByName("release")`——
   文件不存在时该行不执行，release 保持现状（未签名构建）。

## 验收标准

1. `android/keystore/cnstockbot-release.jks` 存在，`keytool -list -v` 可读出
   证书指纹（SHA-256 记录入最终汇报）。
2. `android/keystore/keystore.properties` 四键齐全。
3. 根 `.gitignore` 含 `android/keystore/`；`git status --ignored` 确认
   密钥库与属性文件均为 ignored 状态，**未被跟踪**。
4. `android/app/build.gradle.kts` KTS 语法人工自查无误（本机无法构建验证），
   properties 缺失时构建不得失败。
5. `npm run typecheck` 与 `npm test` 全绿（本任务不改 Node 侧代码，应为零影响）。
6. 文档同步：android/README.md、docs/STATUS.md（更新日志 + 待办勾选 +
   最后更新日期）已更新。

## 审计要点

- **🔴 私钥与密码绝不入库**（本任务最高优先级红线）：
  - 审查 `.gitignore` 是否真的覆盖 `android/keystore/`（含子目录）；
  - 审查 `git ls-files` / `git status` 中不得出现 .jks / keystore.properties；
  - 审查提交 diff 中**不得出现任何密码字符串、密钥材料或指纹以外的密钥内容**；
  - 审查文档与 PR 描述只写机制、不写密码。
- **签名配置的条件加载**：properties 文件不存在时 release 构建必须保持
  现状（不签名、不 fail）；不得因为缺文件让任何构建变体报错。
- **debug 变体零改动**：diff 中 debug 块不得有任何变化，applicationIdSuffix
  等行为保持原样。
- **KTS 语法**：无构建验证条件下手写 Gradle 配置，重点自查类型
  （`findByName` 返回可空、赋值时机在 `signingConfigs` 声明之后）与
  Properties 读取路径（`rootProject.file` 相对 android/ 工程根）。
- **范围裁剪确认**：本任务 diff 中不得出现 Kotlin/XML/manifest 改动；
  如出现说明实现越界。
