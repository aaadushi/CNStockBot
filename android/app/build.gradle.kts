// App 模块：零第三方依赖，纯 Android 框架 + Kotlin。
// 壳只负责"服务端地址配置 + WebView 装载"，业务逻辑全部在网页端。
plugins {
    id("com.android.application")
    kotlin("android")
}

android {
    namespace = "com.cnstockbot.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.cnstockbot.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            // 无混淆需求：壳内无可保护业务代码；如需可后续开启 R8。
            isMinifyEnabled = false
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
