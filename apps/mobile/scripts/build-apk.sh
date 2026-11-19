#!/usr/bin/env bash
# Builds the signed Android release APK locally, with no Expo (EAS) account. Run in Bash (Git Bash on Windows):
#
#   LONGYU_ANDROID_TOOLS=/path/to/tools APP_VARIANT=testnet EXPO_PUBLIC_API_URL=https://... \
#     EXPO_PUBLIC_TURNSTILE_SITE_KEY=... bash apps/mobile/scripts/build-apk.sh
#
# The app is copied to a short folder first: the native build breaks on a path that contains spaces
# and on Windows' 260-character limit, and the repository must not gain an android/ folder.
# Needs the tools described in apps/mobile/BUILD.md. The signing passwords are read from the
# properties file and never printed. Extra arguments go to Gradle, for example
# -PreactNativeArchitectures=arm64-v8a,armeabi-v7a to leave the emulator ABIs out.
set -euo pipefail

APP_VARIANT="${APP_VARIANT:?set APP_VARIANT=testnet or APP_VARIANT=production}"
EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:?set EXPO_PUBLIC_API_URL to the https address of the API}"
EXPO_PUBLIC_TURNSTILE_SITE_KEY="${EXPO_PUBLIC_TURNSTILE_SITE_KEY:?set EXPO_PUBLIC_TURNSTILE_SITE_KEY to the Cloudflare Turnstile site key}"

TOOLS="${LONGYU_ANDROID_TOOLS:?set LONGYU_ANDROID_TOOLS to the folder holding jdk-17, node-22 and sdk (see BUILD.md)}"
JDK="${LONGYU_JDK:-$TOOLS/jdk-17}"
NODE_DIR="${LONGYU_NODE:-$TOOLS/node-22}"
SDK="${LONGYU_ANDROID_SDK:-$TOOLS/sdk}"
WORK="${LONGYU_WORK_DIR:-$TOOLS/work}"
# Gradle tasks run at once. Each native task already starts a C++ compiler per processor; several such
# tasks side by side can need more memory than the machine has, and the build then fails part-way.
GRADLE_WORKERS="${LONGYU_GRADLE_WORKERS:-1}"
OUT="${LONGYU_OUT_DIR:-$TOOLS/out}"
SIGNING="${LONGYU_SIGNING_PROPERTIES:-$HOME/.longyu/android/signing.properties}"
APP="$(cd "$(dirname "$0")/.." && pwd)"

say() { printf '\n> %s\n' "$*"; }
fail() { printf 'build-apk: %s\n' "$*" >&2; exit 1; }
# One value from the signing properties file.
prop() { sed -n "s/^$1=//p" "$SIGNING" | tr -d '\r' | head -n 1; }
# A folder as PATH takes it. Git Bash has cygpath to turn a Windows path into that form; where there
# is no cygpath the path is in that form already.
in_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf '%s\n' "$1"; fi; }

# ------------------------------------------------------------------ checks
case "$APP_VARIANT" in testnet | production) ;; *) fail "APP_VARIANT must be testnet or production" ;; esac
case "$EXPO_PUBLIC_API_URL" in https://*) ;; *) fail "EXPO_PUBLIC_API_URL must be an https URL" ;; esac
case "$EXPO_PUBLIC_TURNSTILE_SITE_KEY" in
  [123]x0000000000000000000*) echo "build-apk: warning: this is one of Cloudflare's test site keys; the APK is not for release" >&2 ;;
esac
case "$WORK" in *" "*) fail "LONGYU_WORK_DIR must not contain a space" ;; esac

[ -x "$JDK/bin/java" ] || fail "no JDK at $JDK (set LONGYU_JDK)"
[ -x "$NODE_DIR/node" ] || fail "no Node at $NODE_DIR (set LONGYU_NODE)"
"$NODE_DIR/node" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" || fail "Expo SDK 58 needs Node 22.13 or newer"
[ -d "$SDK/platforms" ] && [ -d "$SDK/ndk" ] || fail "no Android SDK at $SDK (set LONGYU_ANDROID_SDK)"
BUILD_TOOLS="${LONGYU_BUILD_TOOLS:-$(ls -d "$SDK"/build-tools/*/ 2>/dev/null | sort -V | tail -n 1)}"
BUILD_TOOLS="${BUILD_TOOLS%/}"
APKSIGNER="$BUILD_TOOLS/lib/apksigner.jar"
[ -f "$APKSIGNER" ] && [ -x "$BUILD_TOOLS/aapt2" ] || fail "no Android build-tools under $SDK/build-tools (set LONGYU_BUILD_TOOLS)"

[ -f "$SIGNING" ] || fail "signing properties not found at $SIGNING (set LONGYU_SIGNING_PROPERTIES)"
STORE_FILE="$(prop storeFile)"
KEY_ALIAS="$(prop keyAlias)"
[ -f "$STORE_FILE" ] || fail "keystore not found at $STORE_FILE"
[ -n "$KEY_ALIAS" ] && [ -n "$(prop storePassword)" ] && [ -n "$(prop keyPassword)" ] || fail "$SIGNING needs storeFile, storePassword, keyAlias and keyPassword"
# Open the keystore now, so a wrong password fails here and not after the long build.
KEY_SHA256="$(LONGYU_STORE_PASSWORD="$(prop storePassword)" "$JDK/bin/keytool" -exportcert -keystore "$STORE_FILE" \
  -alias "$KEY_ALIAS" -storepass:env LONGYU_STORE_PASSWORD | sha256sum | cut -d' ' -f1)"

# Everything the build writes stays under the tools folder: its caches run to several gigabytes, and
# the home folder's drive may not have the room.
export JAVA_HOME="$JDK"
export ANDROID_HOME="$SDK"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$TOOLS/gradle-home}"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-$TOOLS/android-user-home}"
export npm_config_cache="${npm_config_cache:-$TOOLS/npm-cache}"
export PATH="$(in_path "$NODE_DIR"):$(in_path "$JDK")/bin:$PATH"
# The release settings app.config.ts insists on (assertReleaseConfig), and no prompts or telemetry from Expo.
export APP_VARIANT EXPO_PUBLIC_API_URL EXPO_PUBLIC_TURNSTILE_SITE_KEY
export EXPO_PUBLIC_DEV_ATTESTATION=false
export LONGYU_RELEASE_CHECK=true
export CI=1 EXPO_NO_TELEMETRY=1 EXPO_NO_GIT_STATUS=1

# ------------------------------------------------------------------ working copy
say "Copying the app to $WORK"
if [ -e "$WORK" ]; then
  [ -f "$WORK/.longyu-build-copy" ] || fail "$WORK exists and was not made by this script; remove it or set LONGYU_WORK_DIR"
  rm -rf "$WORK"
fi
mkdir -p "$WORK" "$OUT"
touch "$WORK/.longyu-build-copy"
# Local env files stay behind: a release build takes its values from the command line only.
tar -C "$APP" --exclude=./node_modules --exclude=./.expo --exclude=./dist --exclude=./android --exclude=./ios \
  --exclude='./.env*' -cf - . | tar -C "$WORK" -xf -
cd "$WORK"

say "Installing dependencies (npm ci)"
npm ci

say "Generating the Android project (expo prebuild)"
npx expo prebuild --platform android --clean --no-install

# ------------------------------------------------------------------ build
say "Building the release APK (Gradle)"
# cmakeObjectPathMax=0 keeps CMake's own limit of 250 characters for object paths, so it shortens the
# long ones. Expo's default of 1024 needs Windows long-path support, which is off by default:
# without this, ninja fails to create a folder deeper than 260 characters.
(cd "$WORK/android" && ./gradlew --no-daemon --max-workers="$GRADLE_WORKERS" assembleRelease -Pexpo.android.cmakeObjectPathMax=0 "$@")
BUILT="$WORK/android/app/build/outputs/apk/release/app-release.apk"
[ -f "$BUILT" ] || fail "Gradle did not produce $BUILT"

BADGING="$("$BUILD_TOOLS/aapt2" dump badging "$BUILT")"
PACKAGE="$(printf '%s\n' "$BADGING" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")"
VERSION_CODE="$(printf '%s\n' "$BADGING" | sed -n "s/^package: .*versionCode='\([^']*\)'.*/\1/p")"
VERSION_NAME="$(printf '%s\n' "$BADGING" | sed -n "s/^package: .*versionName='\([^']*\)'.*/\1/p")"
[ -n "$PACKAGE" ] && [ -n "$VERSION_CODE" ] && [ -n "$VERSION_NAME" ] || fail "could not read the package and version from $BUILT"
! printf '%s\n' "$BADGING" | grep -q '^application-debuggable' || fail "the APK is debuggable; this is not a release build"

# ------------------------------------------------------------------ sign
# Gradle signs release builds with the template's debug key; apksigner replaces that with the release key.
APK="$OUT/${LONGYU_APK_NAME:-longyu-mine-$APP_VARIANT-$VERSION_NAME-$VERSION_CODE.apk}"
say "Signing $APK"
rm -f "$APK"
LONGYU_STORE_PASSWORD="$(prop storePassword)" LONGYU_KEY_PASSWORD="$(prop keyPassword)" \
  "$JDK/bin/java" -jar "$APKSIGNER" sign --ks "$STORE_FILE" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass env:LONGYU_STORE_PASSWORD --key-pass env:LONGYU_KEY_PASSWORD \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false \
  --out "$APK" "$BUILT"

VERIFY="$("$JDK/bin/java" -jar "$APKSIGNER" verify --verbose --print-certs "$APK")"
[ "$(printf '%s\n' "$VERIFY" | grep -c 'certificate SHA-256 digest')" = 1 ] || fail "expected exactly one signer on $APK"
APK_CERT="$(printf '%s\n' "$VERIFY" | sed -n 's/^.*certificate SHA-256 digest: //p' | tr -d '\r')"
[ "$APK_CERT" = "$KEY_SHA256" ] || fail "$APK is not signed with the key in $STORE_FILE"
# Native libraries are stored uncompressed and must sit on 16 KB boundaries for newer phones.
"$BUILD_TOOLS/zipalign" -c -P 16 4 "$APK" || fail "$APK is not zip-aligned"

# ------------------------------------------------------------------ result
say "Done"
echo "APK:                  $APK"
echo "APK SHA-256:          $(sha256sum "$APK" | cut -d' ' -f1)"
echo "Package:              $PACKAGE"
echo "Version:              $VERSION_NAME (versionCode $VERSION_CODE)"
echo "Signing cert SHA-256: $APK_CERT"
