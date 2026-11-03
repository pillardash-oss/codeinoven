#!/usr/bin/env bash
# Boot the Android emulator and put a debug build of the mobile app on it, wired
# to a development backend on the host. The emulator reaches the host loopback
# through 10.0.2.2, and the app is permitted cleartext for that alias alone by
# `android/app/src/main/res/xml/network_security_config.xml`.
#
#   ./scripts/android-emulator-dev.sh                      # build, install, launch
#   ./scripts/android-emulator-dev.sh --api http://10.0.2.2:8081
#   ./scripts/android-emulator-dev.sh --avd cio_mobile --no-build
#
# The emulator is left running when the script exits: a window stays visible on
# the machine, so a boot costs nothing on the next run.
set -euo pipefail

SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
export PATH="$SDK/platform-tools:$SDK/emulator:$SDK/cmdline-tools/latest/bin:$PATH"

AVD="cio_mobile"
API_BASE="http://10.0.2.2:8081"
IMAGE="system-images;android-35;google_apis_playstore;arm64-v8a"
DEVICE_PROFILE="pixel_7"
APP_ID="com.pillardash.codeinoven"
ACTIVITY="$APP_ID/.MainActivity"
BUILD=true

while [ $# -gt 0 ]; do
  case "$1" in
    --avd) AVD="$2"; shift 2 ;;
    --api) API_BASE="$2"; shift 2 ;;
    --no-build) BUILD=false; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")/.."
mkdir -p "$ANDROID_HOME" 2>/dev/null || true

# 1. The AVD. Never recreated when it already exists: it may carry state the
#    person running this is in the middle of using.
if ! avdmanager list avd | grep -q "Name: $AVD$"; then
  echo "creating AVD $AVD from $IMAGE"
  echo "no" | avdmanager create avd -n "$AVD" -k "$IMAGE" -d "$DEVICE_PROFILE"
fi

# 2. Boot it visibly, then wait for the framework to finish starting.
if ! adb devices | grep -q "^emulator-.*device$"; then
  echo "booting $AVD"
  nohup emulator -avd "$AVD" -no-boot-anim -no-snapshot-save \
    >"${TMPDIR:-/tmp}/cio-emulator-$AVD.log" 2>&1 &
fi

adb wait-for-device
for _ in $(seq 1 150); do
  if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
    break
  fi
  sleep 2
done
if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; then
  echo "the emulator did not finish booting" >&2
  exit 1
fi
adb shell input keyevent 82 >/dev/null

# 3. The native shell. `cap add android` overwrites the generated project, so it
#    only runs when the folder is missing.
if [ ! -d android ]; then
  bunx cap add android
fi

# 4. Build the web bundle with the backend origin baked in, copy it into the
#    shell, and package the debug APK. `VITE_API_BASE` is exported for the whole
#    step, not just the bundle: `cap sync` reads it too, and it is what decides
#    whether the WebView may open a plain HTTP request from its https://localhost
#    origin. A build whose sync ran without it packages a shell that drops every
#    call to the backend as mixed content.
if [ "$BUILD" = true ]; then
  export VITE_API_BASE="$API_BASE"
  bun run build
  bunx cap sync android
  (cd android && ./gradlew assembleDebug)
fi

APK="android/app/build/outputs/apk/debug/app-debug.apk"
[ -f "$APK" ] || { echo "no APK at $APK" >&2; exit 1; }

# 5. Install and launch.
adb install -r "$APK"
adb shell am force-stop "$APP_ID" || true
adb shell am start -n "$ACTIVITY"

echo "installed $(du -h "$APK" | cut -f1) from $APK against $API_BASE"
adb devices | grep emulator-
