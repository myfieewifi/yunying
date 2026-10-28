#!/usr/bin/env bash
# download-mpv.sh
# 从 Maven Central 下载 mpv-android-lib AAR（io.github.abdallahmehiz:mpv-android-lib，
# mpvKt 所用内核库，含 libmpv.so + libplayer.so JNI 桥 + ffmpeg，全 ABI）到 app/libs/。
# 注意：mpv-android 官方 Release 只发 APK（无 AAR），不能作为依赖来源。
# 如果下载失败，将跳过本地 AAR，APK 无 mpv 内核（运行时自动回退 ExoPlayer，不闪退）。

set -euo pipefail

MPV_AAR_VERSION="${MPV_AAR_VERSION:-0.1.12}"
MPV_AAR_URL="https://repo1.maven.org/maven2/io/github/abdallahmehiz/mpv-android-lib/${MPV_AAR_VERSION}/mpv-android-lib-${MPV_AAR_VERSION}.aar"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIBS_DIR="${SCRIPT_DIR}/../app/libs"
mkdir -p "${LIBS_DIR}"
TARGET="${LIBS_DIR}/libmpv-${MPV_AAR_VERSION}.aar"

if [ -f "${TARGET}" ]; then
  echo "✓ mpv AAR 已存在：${TARGET}"
  exit 0
fi

echo "⇩ 尝试下载 mpv AAR：${MPV_AAR_URL}"
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 --connect-timeout 15 -o "${TARGET}" "${MPV_AAR_URL}" || {
    echo "!! Maven Central 下载失败，跳过本 AAR，APK 将不含 mpv 内核"
    rm -f "${TARGET}"
    exit 0
  }
elif command -v wget >/dev/null 2>&1; then
  wget --timeout=15 -O "${TARGET}" "${MPV_AAR_URL}" || {
    echo "!! Maven Central 下载失败，跳过本 AAR，APK 将不含 mpv 内核"
    rm -f "${TARGET}"
    exit 0
  }
else
  echo "!! 需要 curl 或 wget 才能下载 mpv AAR，跳过"
  exit 0
fi

echo "✓ mpv AAR 下载完成：${TARGET}"
ls -lh "${TARGET}"
