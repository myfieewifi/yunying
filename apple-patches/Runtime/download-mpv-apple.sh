#!/usr/bin/env bash
# download-mpv-apple.sh
# 下载/构建 Apple 平台用的 libmpv XCFramework（iOS / tvOS / macOS arm64+x86_64）
# 优先从 mpvKit 预编译 release 获取，失败时给出源码编译指引。

set -euo pipefail

MPV_KIT_VERSION="${MPV_KIT_VERSION:-0.2.0}"
VENDOR_DIR="${VENDOR_DIR:-$(cd "$(dirname "$0")/../../Vendor" && pwd)}"
mkdir -p "${VENDOR_DIR}"

MPVKIT_DIR="${VENDOR_DIR}/MPVKit.xcframework"
if [ -d "${MPVKIT_DIR}" ]; then
  echo "✓ MPVKit.xcframework 已存在"
  exit 0
fi

# 预编译 release URL（社区构建版：支持 ios-arm64 / tvos-arm64 / macos-arm64_x86_64）
# 该构建源：https://github.com/mpvkit/MPVKit（SPM 可直接引用，此处仅作 CI 预下载缓存）
TARBALL_URL="${MPVKIT_TARBALL:-https://github.com/mpvkit/MPVKit/releases/download/${MPV_KIT_VERSION}/MPVKit.xcframework.zip}"
TARBALL="${VENDOR_DIR}/MPVKit.xcframework.zip"

echo "→ 下载 MPVKit.xcframework：${TARBALL_URL}"
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 -o "${TARBALL}" "${TARBALL_URL}" || {
    echo "!! MPVKit 预编译下载失败，将改为在 Xcode 中通过 SPM 引用 https://github.com/mpvkit/MPVKit"
    rm -f "${TARBALL}"
    exit 0
  }
elif command -v wget >/dev/null 2>&1; then
  wget -O "${TARBALL}" "${TARBALL_URL}" || {
    echo "!! MPVKit 预编译下载失败，将改为在 Xcode 中通过 SPM 引用 https://github.com/mpvkit/MPVKit"
    rm -f "${TARBALL}"
    exit 0
  }
fi

echo "→ 解压 MPVKit.xcframework"
cd "${VENDOR_DIR}"
unzip -q "${TARBALL}"
rm -f "${TARBALL}"
echo "✓ MPVKit 准备完成：${MPVKIT_DIR}"
