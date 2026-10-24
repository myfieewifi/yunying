#!/usr/bin/env bash
# download-mpv.sh
# 在 CI / 本地开发时下载 mpv-android 的 libmpv 预编译 AAR 到 app/libs/
# 如果下载失败，将跳过本地 AAR，改由 Gradle 使用 Maven 依赖兜底

set -euo pipefail

MPV_VERSION="${MPV_VERSION:-2024-10-27}"
MPV_AAR_NAME="libmpv-${MPV_VERSION}.aar"
MPV_RELEASE_URL="https://github.com/mpv-android/mpv-android/releases/download/${MPV_VERSION}/${MPV_AAR_NAME}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIBS_DIR="${SCRIPT_DIR}/../app/libs"
mkdir -p "${LIBS_DIR}"
TARGET="${LIBS_DIR}/${MPV_AAR_NAME}"

if [ -f "${TARGET}" ]; then
  echo "✓ mpv AAR 已存在：${TARGET}"
  exit 0
fi

echo "→ 尝试下载 mpv AAR：${MPV_RELEASE_URL}"
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 2 --connect-timeout 10 -o "${TARGET}" "${MPV_RELEASE_URL}" || {
    echo "!! GitHub Release 下载失败，跳过本地 AAR，使用 Gradle Maven 依赖兜底"
    rm -f "${TARGET}"
    exit 0
  }
elif command -v wget >/dev/null 2>&1; then
  wget --timeout=10 -O "${TARGET}" "${MPV_RELEASE_URL}" || {
    echo "!! GitHub Release 下载失败，跳过本地 AAR，使用 Gradle Maven 依赖兜底"
    rm -f "${TARGET}"
    exit 0
  }
else
  echo "!! 需要 curl 或 wget 才能下载 mpv AAR，跳过并使用 Gradle Maven 依赖兜底"
  exit 0
fi

echo "✓ mpv AAR 下载完成：${TARGET}"
ls -lh "${TARGET}"
