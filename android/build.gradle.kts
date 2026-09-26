// 顶层构建脚本：插件版本集中声明（apply false，由 app 模块应用）。
plugins {
    id("com.android.application") version "8.5.2" apply false
    kotlin("android") version "1.9.24" apply false
}
