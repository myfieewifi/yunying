#!/usr/bin/env bash
# 构建 iOS / tvOS 嵌入式 Python 运行时，产出 python-stdlib.zip 放进 ScriptAssets/python/，
# 以及下载 BeeWare Python.xcframework 到 Vendor/Python-Apple-support/。
# 用法： Scripts/build-python-host-ios.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$ROOT/Sources/TVCore/ScriptAssets/python"
HOST="$ROOT/Runtime/PythonHost"
VENDOR="$ROOT/Vendor/Python-Apple-support"
IOS_PY_VER="${IOS_PY_VER:-3.12}"
BEEWARE_REL="${BEEWARE_REL:-2024072700}"   # BeeWare Python-Apple-support release tag

mkdir -p "$ASSETS/host/base" "$VENDOR"

# 1. 准备 host.py / base/spider.py（与 macOS 版复用）
cp "$HOST/host.py"               "$ASSETS/host/host.py"
cp "$HOST/base/spider.py"        "$ASSETS/host/base/spider.py"
cp "$HOST/requirements.txt"      "$ASSETS/host/requirements.txt"

# 2. 下载 BeeWare Python.xcframework（含 iOS 设备、模拟器、tvOS 三架构的静态 Python）
download_xcframework() {
  local name="$1"; local url="$2"; local zip="$VENDOR/$name.zip"
  if [ ! -d "$VENDOR/$name.xcframework" ]; then
    echo "▶ 下载 $name from $url"
    curl -L --fail -o "$zip" "$url"
    unzip -q -o "$zip" -d "$VENDOR"
    rm -f "$zip"
  fi
}
download_xcframework "Python-Standalone" \
  "https://github.com/beeware/Python-Apple-support/releases/download/$BEEWARE_REL/Python-$IOS_PY_VER-ios-support.$BEEWARE_REL.tar.gz" || true
# tvOS
download_xcframework "Python-tvOS" \
  "https://github.com/beeware/Python-Apple-support/releases/download/$BEEWARE_REL/Python-$IOS_PY_VER-tvos-support.$BEEWARE_REL.tar.gz" || true

# 3. 打包 Python 标准库 zip（host.py 通过 PYTHONHOME 指向该 zip）
# （从 xcframework 里的 Modules/ 拷贝 .py 出来压缩）
if [ -d "$VENDOR/Python-Standalone.xcframework/ios-arm64/Modules" ]; then
  (cd "$VENDOR/Python-Standalone.xcframework/ios-arm64/Modules" && \
     zip -qr "$ASSETS/python-stdlib.zip" . -x "*.pyc" "__pycache__/*")
  echo "✅ python-stdlib.zip -> $ASSETS/python-stdlib.zip"
else
  echo "⚠️ 未找到 Python-Standalone.xcframework，本地开发可忽略，CI 会自动准备。"
fi

# 4. 预装第三方 site-packages（requests / urllib3 / certifi / charset_normalizer / idna）
SITE="$ASSETS/host/site-packages"
mkdir -p "$SITE"
if command -v pip3 >/dev/null 2>&1; then
  pip3 install --target="$SITE" -r "$HOST/requirements.txt" --upgrade \
        --no-compile --no-cache-dir 2>/dev/null || true
  echo "✅ site-packages -> $SITE"
fi

echo "✅ iOS/tvOS Python 运行时构建完成。"
