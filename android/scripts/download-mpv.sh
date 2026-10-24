#!/usr/bin/env bash
# download-mpv.sh
# 在 CI / 本地开发时下载 mpv-android 的 libmpv 预编译 AAR 到 app/libs/
# 来源：mpv-android 官方 GitHub release https://github.com/mpv-android/mpv-android/releases
# 选择版本：2024-10-27（最新稳定版，支持 arm64-v8a / armeabi-v7a / x86_64）

set -euo pipefail

MPV_VERSION="${MPV_VERSION:-2024-10-27}"
MPV_AAR_NAME="libmpv-${MPV_VERSION}.aar"
MPV_RELEASE_URL="https://github.com/mpv-android/mpv-android/releases/download/v${MPV_VERSION}/${MPV_AAR_NAME}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIBS_DIR="${SCRIPT_DIR}/../app/libs"
mkdir -p "${LIBS_DIR}"
TARGET="${LIBS_DIR}/${MPV_AAR_NAME}"

if [ -f "${TARGET}" ]; then
  echo "✓ mpv AAR 已存在：${TARGET}"
  exit 0
fi

echo "→ 下载 mpv AAR：${MPV_RELEASE_URL}"
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 -o "${TARGET}" "${MPV_RELEASE_URL}"
elif command -v wget >/dev/null 2>&1; then
  wget -O "${TARGET}" "${MPV_RELEASE_URL}"
else
  echo "!! 需要 curl 或 wget 才能下载 mpv AAR"
  exit 1
fi

echo "✓ mpv AAR 下载完成：${TARGET}"
ls -lh "${TARGET}"
