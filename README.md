# 云映 (YunYing)

> 在开源 [映匣 (Yingxia, tvbox-silicon)](https://github.com/jo32/tvbox-silicon) 基础上二次开发的全平台空壳播放器，UI 与映匣保持一致。

## ✨ 特性

| 平台 | UI | 源/爬虫支持 | 安装方式 |
|---|---|---|---|
| **Android / Android TV** | 复刻映匣 SwiftUI 风格 | ✅ json / js / js.md(drpy) / py / jar | APK 直装 |
| **iOS** (iPhone/iPad) | 与映匣 1:1 | ✅ json / js / js.md(drpy) / py / jar | **TrollStore** 免签 IPA |
| **tvOS** (Apple TV) | 与映匣 1:1 | ✅ json / js / js.md(drpy) / py / jar | TrollStore / 侧载 |
| **macOS** (Apple Silicon + Intel) | 与映匣 1:1 | ✅ json / js / js.md(drpy) / py / jar | DMG |

### 🎬 双内核切换（新增 mpv）

云映采用 **"默认原生 + mpv 兜底"** 的双内核策略，播放器右上角可一键切换：

| 内核 | 定位 | 优势 | 适用场景 |
|---|---|---|---|
| **ExoPlayer / AVPlayer** | 默认 | 省电、系统级硬解、HLS 流畅 | 主流 HLS/MP4 源 |
| **mpv (libmpv)** | 全能兜底 | 几乎兼容**所有格式/编码**（H.265/HEVC、AV1、MPEG2、MKV、FLV、TS、RMVB…） | ExoPlayer/AVPlayer 播不动的冷门源、MKV/FLV、特殊编码直播 |
| **Auto**（默认） | 智能切换 | 先用默认内核播放，失败自动切 mpv 重试 | 日常推荐 |

- **安卓**：`libmpv`（mpv-android 预编译 AAR，arm64-v8a / armeabi-v7a / x86_64），`hwdec=mediacodec-copy`
- **Apple**：`MPVKit`（libmpv Metal 渲染，VideoToolbox 硬解），覆盖 iOS / tvOS / macOS
- 内核选择会持久化保存（安卓 `SharedPreferences`，Apple `UserDefaults`）

**源/爬虫完整对照 TVBox 规范**：
- `spider` 字段支持：`.jar`、`.js`、`.py`、js.md（drpy/drpy2/海阔）
- `sites` 字段支持：纯 JSON 源、`api` 指向 `.js`/`.py`/`.js.md`/`.md`/`csp_` 类名
- 直播：`lives` 字段（M3U / TXT）全部兼容
- js.md 中的 \`\`\`js 代码块自动提取并注入 drpy 模板库执行

## 📦 一键编译 (GitHub Actions)

本仓库已配置好三条工作流：

| 工作流文件 | 产出 |
|---|---|
| `.github/workflows/build-android.yml` | `YunYing-Android-<version>.apk` |
| `.github/workflows/build-apple.yml` | `YunYing-iOS-<version>.ipa`（TrollStore 免签）+ `YunYing-tvOS-<version>.ipa` + `YunYing-macOS-<version>.dmg` |
| `.github/workflows/build-all.yml` | 以上全部 |

### 使用方法

1. **Fork 本仓库**到你自己的 GitHub 账号。
2. 去仓库 → **Actions** → 选择对应 workflow → **Run workflow** → 选分支 `main` → 点 Run。
3. 等待 ~20–40 分钟，Artifacts 里下载安装包：
   - **iOS/tvOS IPA**：用 TrollStore 直接安装（无需证书、无需重签、永不过期）。
   - **macOS DMG**：打开拖入 Applications。
   - **Android APK**：直接安装。

> 💡 iOS 端编译出的 IPA 使用 `get-task-allow=true` + `Ad Hoc` 签名占位，**专门为 TrollStore 设计**，TrollStore 安装时会自动将签名改为 ldid 伪签名，无需你提供任何证书。

## 🔧 本地构建

### Apple 端 (macOS + Xcode 必需)

```bash
git clone --recursive https://github.com/<your-name>/YunYing.git
cd YunYing

# 1. 把补丁打进映匣源码
./apple-patches/apply.sh

# 2. 构建运行时宿主
cd yingxia-src
export JAVA_HOME="$(/usr/libexec/java_home -v 19)"
Scripts/build-java-host.sh
Scripts/build-script-host.sh
Scripts/build-python-host.sh    # iOS/tvOS 也能用了（补丁里扩展了）

# 3. 生成 Xcode 工程
xcodegen generate
open TVBox.xcodeproj
# 选 target: TVBox-iOS / TVBox-tvOS / TVBox-macOS
```

### Android 端

```bash
cd android
./gradlew assembleRelease
# APK 位置: app/build/outputs/apk/release/YunYing-release.apk
```

## 🧭 项目结构

```
YunYing/
├── yingxia-src/              # 映匣原版源码（子模块）
├── apple-patches/            # 二开补丁：js.md 解析、iOS 内嵌 Python
│   ├── apply.sh
│   ├── Sources/TVCore/       # DrpyParser / IOSPythonHost 等 Swift 源码
│   └── Runtime/PythonHost/   # iOS/tvOS 用的嵌入式 Python 框架说明
├── android/                  # 安卓端工程（Kotlin + Compose, 对齐映匣 UI）
│   └── app/
├── .github/workflows/        # CI 编译工作流
└── README.md
```

## 🔑 二开说明 (相对映匣原版)

1. **js.md / drpy 解析**：`apple-patches/Sources/TVCore/DrpyParser.swift` 新增解析器。加载 `.js.md` / `.md` 源时：
   - 提取 ```js ... ``` 代码块
   - 与映匣内置的 `模板.js`（drpy 模板库）拼合后交给 QuickJS 执行
   - 与原版 JS spider 走同一调用路径，`homeContent/searchContent/detailContent/playerContent` 完全兼容

2. **iOS / tvOS Python 爬虫**：原版映匣仅 macOS 可跑 `.py` 爬虫。补丁通过嵌入 `Python.xcframework`（基于 [kivy-ios](https://github.com/kivy/kivy-ios) / [BeeWare](https://github.com/beeware/Python-Apple-support) 构建）在 iOS/tvOS 也可用，host 协议与 macOS 版 `host.py` 完全一致。

3. **安卓端**：独立工程（Kotlin + Jetpack Compose + ExoPlayer + QuickJS + Chaquopy (Python)），UI 参考映匣 SwiftUI 视觉：侧边栏 Shelf、毛玻璃、卡片式站点货架、直播 Guide 视图。

4. **TrollStore IPA**：CI 在 macOS runner 上用 xcodebuild 出 `.app` 后，手工打 `ipa` 包，Info.plist 里 `CFBundleSignature` 保持为 `????`，不做 codesign，让 TrollStore 自己重签。

## 📄 许可证

映匣原版代码遵循 **GPL-3.0**，本二开项目同样以 **GPL-3.0** 开源。使用、分发、再二开请遵守许可证条款。
