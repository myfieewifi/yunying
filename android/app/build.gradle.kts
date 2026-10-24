plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")   // 启用 Chaquopy，提供 Python 运行时
}

android {
    namespace = "com.tvbox.yunying"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.tvbox.yunying"
        minSdk = 21                // 兼容 Android 5+
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
        ndk {
            abiFilters += listOf("armeabi-v7a", "arm64-v8a", "x86_64")
        }
        // Chaquopy: 配置 Python（Chaquopy 15 DSL：defaultConfig.python 已改为 chaquopy）
        chaquopy {
            defaultConfig {
                pip {
                    install("requests")
                    install("urllib3")
                    install("certifi")
                    install("charset-normalizer")
                    install("idna")
                }
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // CI 分发的 release APK 必须有签名，否则手机侧载时报“解析包时出错”。
            // 没有正式签名密钥时用 debug 签名（本地 keystore，任何机器可用，安装无碍）。
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    composeOptions { kotlinCompilerExtensionVersion = "1.5.14" }

    sourceSets {
        getByName("main") {
            // Chaquopy 自动拾取 src/main/python/ 目录；这里只配置其余资源
            // QuickJS + JAR(Dex) 运行时放置
            jniLibs.srcDir("src/main/jniLibs")
            assets.srcDirs("src/main/assets")
        }
    }
}

dependencies {
    // Chaquopy 运行时由插件自动注入（com.chaquo.python:android 坐标在其他仓库均不存在，勿手动添加）

    // AndroidX + Compose
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.1")
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")           // 类似 SwiftUI 风格
    implementation("com.google.android.material:material:1.12.0")   // View 版 M3（styles.xml 的 Theme.Material3.* 需要）
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.navigation:navigation-compose:2.7.7")
    implementation("androidx.tv:tv-foundation:1.0.0-alpha10")      // Android TV 遥控器支持（alpha12 不存在）
    implementation("androidx.tv:tv-material:1.0.0-alpha10")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.3")

    // 播放器: Media3 (ExoPlayer)
    implementation("androidx.media3:media3-exoplayer:1.3.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.3.1")
    implementation("androidx.media3:media3-ui:1.3.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.3.1")

    // 网络: OkHttp + Retrofit
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("com.google.code.gson:gson:2.10.1")

    // JS 运行时: QuickJS-Android（taoweiji/quickjs-android，square1io 的 jitpack 坐标不存在）
    implementation("io.github.taoweiji.quickjs:quickjs-android:1.4.6")

    // mpv 内核（libmpv）——预编译 AAR，CI/本地手动下载放到 android/app/libs/ 下，文件名匹配 libmpv*.aar
    // mpv-android 官方 Release 只发布 APK，没有稳定 AAR 坐标，因此不提供 Maven 兜底依赖；
    // MpvPlayerEngine 为纯反射实现：没有 libmpv 时编译/打包不受影响，运行时优雅回退 ExoPlayer
    implementation(fileTree("libs") { include("libmpv*.aar") })

    // HTML 解析（爬虫常用）
    implementation("org.jsoup:jsoup:1.17.2")

    // 图片加载（海报）
    implementation("io.coil-kt:coil-compose:2.6.0")

    // 毛玻璃（对齐映匣 GlassKit；haze 没有发布 0.9.0 正式版，API 最接近的是 0.9.0-rc03）
    implementation("dev.chrisbanes.haze:haze:0.9.0-rc03")

    // 本地偏好 / JSON 配置
    implementation("androidx.datastore:datastore-preferences:1.1.1")
}
