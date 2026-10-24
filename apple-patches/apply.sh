#!/usr/bin/env bash
# 把 apple-patches/ 下的源码注入到映匣源码 yingxia-src/ 中。
# 用法： ./apple-patches/apply.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/yingxia-src"
PATCH="$ROOT/apple-patches"

if [ ! -d "$SRC" ]; then
  echo "❌ 未找到 yingxia-src 目录。将在 CI 中由工作流克隆 tvbox-silicon"
  # 在 CI 环境下，工作流会先克隆；这里宽松处理
fi

if [ ! -d "$SRC/Sources/TVCore" ]; then
  echo "⚠️  未找到 yingxia-src/Sources/TVCore，跳过 Swift 补丁拷贝（将在克隆后应用）"
else
  echo "▶ 拷贝 Swift 补丁到 TVCore ..."
  mkdir -p "$SRC/Sources/TVCore/Player"
  [ -f "$PATCH/Sources/TVCore/DrpyParser.swift" ] && cp -v "$PATCH/Sources/TVCore/DrpyParser.swift"       "$SRC/Sources/TVCore/DrpyParser.swift" || true
  [ -f "$PATCH/Sources/TVCore/IOSPythonHost.swift" ] && cp -v "$PATCH/Sources/TVCore/IOSPythonHost.swift"    "$SRC/Sources/TVCore/IOSPythonHost.swift" || true
  [ -f "$PATCH/Sources/TVCore/Player/MPVPlayerEngine.swift" ] && cp -v "$PATCH/Sources/TVCore/Player/MPVPlayerEngine.swift" "$SRC/Sources/TVCore/Player/MPVPlayerEngine.swift" || true
fi

echo "▶ 下载/准备 MPVKit（mpv Apple 平台预编译）..."
bash "$PATCH/Runtime/download-mpv-apple.sh" || true

if [ -d "$SRC" ]; then
  echo "▶ 拷贝 iOS Python host.py 到 Runtime/PythonHost ..."
  mkdir -p "$SRC/Runtime/PythonHost/ios" "$SRC/Scripts"
  [ -f "$PATCH/Runtime/PythonHost/host_ios.py" ] && cp -v "$PATCH/Runtime/PythonHost/host_ios.py"        "$SRC/Runtime/PythonHost/ios/host.py" || true
  [ -f "$PATCH/Runtime/PythonHost/build-python-ios.sh" ] && cp -v "$PATCH/Runtime/PythonHost/build-python-ios.sh" "$SRC/Scripts/build-python-host-ios.sh" || true
  [ -f "$SRC/Scripts/build-python-host-ios.sh" ] && chmod +x "$SRC/Scripts/build-python-host-ios.sh" || true
fi

echo "▶ 补丁应用完成。"
