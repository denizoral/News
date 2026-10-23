#!/usr/bin/env bash
# Builds both apps and puts the APKs where the server offers them:
#   http://<server>/apps/frontier-wire.apk and /apps/wire-admin.apk
# Usage: android/build-apks.sh [-Pwire.apiBase=https://…] [-Pwire.googleClientId=…]
set -euo pipefail
cd "$(dirname "$0")"
export ANDROID_HOME=${ANDROID_HOME:-/opt/android-sdk}
./gradlew -q :app:assembleRelease :admin:assembleRelease "$@"
mkdir -p ../data/apps
cp app/build/outputs/apk/release/app-release.apk ../data/apps/frontier-wire.apk
cp admin/build/outputs/apk/release/admin-release.apk ../data/apps/wire-admin.apk
ls -la ../data/apps
