#!/usr/bin/env bash
# 把 apple-patches/ 下的源码注入到映匣源码 yingxia-src/ 中。
# 用法： ./apple-patches/apply.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/yingxia-src"
PATCH="$ROOT/apple-patches"

if [ ! -d "$SRC/Sources/TVCore" ]; then
  echo "❌ 未找到 yingxia-src/Sources/TVCore。请先在仓库根目录执行 git submodule update --init"
  exit 1
fi

echo "▶ 拷贝 Swift 补丁到 TVCore ..."
mkdir -p "$SRC/Sources/TVCore/Player"
cp -v "$PATCH/Sources/TVCore/DrpyParser.swift"       "$SRC/Sources/TVCore/DrpyParser.swift"
cp -v "$PATCH/Sources/TVCore/IOSPythonHost.swift"    "$SRC/Sources/TVCore/IOSPythonHost.swift"
cp -v "$PATCH/Sources/TVCore/Player/MPVPlayerEngine.swift" "$SRC/Sources/TVCore/Player/MPVPlayerEngine.swift"

echo "▶ 下载/准备 MPVKit（mpv Apple 平台预编译）..."
bash "$PATCH/Runtime/download-mpv-apple.sh"

echo "▶ 拷贝 iOS Python host.py 到 Runtime/PythonHost ..."
mkdir -p "$SRC/Runtime/PythonHost/ios"
cp -v "$PATCH/Runtime/PythonHost/host_ios.py"        "$SRC/Runtime/PythonHost/ios/host.py"
cp -v "$PATCH/Runtime/PythonHost/build-python-ios.sh" "$SRC/Scripts/build-python-host-ios.sh"
chmod +x "$SRC/Scripts/build-python-host-ios.sh"

echo "▶ 在 Package.swift 里注册新源文件 ..."
if ! grep -q "DrpyParser.swift" "$SRC/Package.swift"; then
  # 在 targets: [.target(name: "TVCore" ...)] 里给 exclude 前插入 resources 扩展即可；
  # SwiftPM 会自动拾取 Sources 目录下的新 .swift 文件，所以此处无需手改。
  echo "   (SwiftPM 自动拾取，无需改 Package.swift)"
fi

echo "▶ 在 project.yml 把新文件加入 Xcode 工程 ..."
# XcodeGen generate 时会扫 Sources 目录，因此也不需要手改 project.yml；我们只要保证文件在 Sources/TVCore 下。

echo "✅ 补丁应用完成。下一步：在 yingxia-src/ 下执行 xcodegen generate 生成工程。"
