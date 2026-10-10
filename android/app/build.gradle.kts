// App 模块：零第三方依赖，纯 Android 框架 + Kotlin。
// 壳只负责"服务端地址配置 + WebView 装载"，业务逻辑全部在网页端。
import java.util.Properties

plugins {
    id("com.android.application")
    kotlin("android")
}

// release 签名（公网分发前置）：仅当本机存在 keystore/keystore.properties
// 时读取并启用；文件不存在（如新克隆机器）时 release 保持未签名，构建不失败。
// 该目录已在根 .gitignore 中排除，私钥与密码绝不入库。
val releaseKeystoreProps: Properties? =
    rootProject.file("keystore/keystore.properties").takeIf { it.exists() }?.let { file ->
        Properties().apply {
            file.inputStream().use { load(it) }
        }
    }

android {
    namespace = "com.cnstockbot.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.cnstockbot.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.0"
    }

    signingConfigs {
        // 仅在 keystore.properties 存在时创建；否则 release 走未签名构建（现状）。
        if (releaseKeystoreProps != null) {
            create("release") {
                storeFile = rootProject.file(releaseKeystoreProps!!.getProperty("storeFile"))
                storePassword = releaseKeystoreProps!!.getProperty("storePassword")
                keyAlias = releaseKeystoreProps!!.getProperty("keyAlias")
                keyPassword = releaseKeystoreProps!!.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // 无混淆需求：壳内无可保护业务代码；如需可后续开启 R8。
            isMinifyEnabled = false
            // 密钥库存在时产出已签名 APK；不存在时保持未签名（不 fail）。
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    kotlinOptions.jvmTarget = "17"
}

dependencies {
    // 有意为空：不使用 androidx / 第三方库，任何较新版本 Android Studio 均可直接 Sync。
}
