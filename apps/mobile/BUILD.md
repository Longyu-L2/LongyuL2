# Building the Android APK

The release APK is built locally, with no Expo (EAS) account and nothing uploaded anywhere.

## Tools

Put these in one folder and point `LONGYU_ANDROID_TOOLS` at it. Nothing needs to be installed system-wide.

| Tool | Subfolder | Why |
| --- | --- | --- |
| JDK 17 (Eclipse Temurin) | `jdk-17/` | Gradle and the Android build |
| Node 22.13 or newer | `node-22/` | Expo SDK 58 and React Native 0.88 |
| Android SDK | `sdk/` | command-line tools, platform 37, build-tools 37.0.0 and 36.0.0, NDK 27.1.12297006, CMake 3.22.1 |

To add an SDK package later: `JAVA_HOME=$LONGYU_ANDROID_TOOLS/jdk-17 $LONGYU_ANDROID_TOOLS/sdk/cmdline-tools/latest/bin/sdkmanager --sdk_root=$LONGYU_ANDROID_TOOLS/sdk "<package>"`.

Each location can also be set on its own: `LONGYU_JDK`, `LONGYU_NODE`, `LONGYU_ANDROID_SDK`, `LONGYU_WORK_DIR`, `LONGYU_OUT_DIR`, `LONGYU_SIGNING_PROPERTIES`.

## The one command

In Bash (Git Bash on Windows), from the repository root:

```bash
LONGYU_ANDROID_TOOLS=/path/to/tools APP_VARIANT=testnet EXPO_PUBLIC_API_URL=https://... \
  EXPO_PUBLIC_TURNSTILE_SITE_KEY=... bash apps/mobile/scripts/build-apk.sh
```

The script refuses to run without those values. It copies the app to a work folder (`LONGYU_WORK_DIR`, by default `work/` inside the tools folder), runs `npm ci`, `expo prebuild` and Gradle there, signs the APK and prints its path, SHA-256, package, version and signing certificate. The APK lands in `out/` inside the tools folder.

On Windows keep the work folder's path short and free of spaces: native builds break on spaces and on the 260-character path limit. Never run `expo prebuild` inside the repository: it must not gain an `android/` folder.

The build uses the files as they are on disk, committed or not, so build from a clean checkout of the commit being released. A full build takes about 40 minutes and several gigabytes of free memory. The script runs one Gradle task at a time for that reason; `LONGYU_GRADLE_WORKERS=4` is faster on a machine with memory to spare.

The version comes from `version` in `app.json`. The version code comes from `android.versionCode` in `app.json`; raise it for every APK that is published, or phones will not take it as an update.

## The signing key

- The keystore and a `signing.properties` file with its passwords live outside the repository, by default in `~/.longyu/android/`.
- Neither is in the repository, and neither may ever be.

Back that folder up somewhere safe and offline. If the keystore or its password is lost, no update can be installed over the app people already have: Android only accepts an update signed with the same key.

The API checks this key too: `ANDROID_SIGNING_CERT_SHA256` must be the certificate SHA-256 the script prints.

## Publishing the APK, and the web build

The `mine` service (`site/`) serves the app's web build and the APK download. To publish a new APK, put it in `site/downloads/` in place of the old one (`site/downloads/README.md`) and deploy the service. Give its SHA-256 wherever the link is given.

The web build needs none of the Android tools. `site/Dockerfile` makes it; to make it by hand:

```bash
cd apps/mobile
APP_VARIANT=testnet EXPO_PUBLIC_API_URL=https://... EXPO_PUBLIC_TURNSTILE_SITE_KEY=... npx expo export --platform web --output-dir site/dist
EXPO_PUBLIC_API_URL=https://... node site/server.mjs      # http://localhost:8080
```

`APP_VARIANT=production` (with `EXPO_PUBLIC_API_URL=https://api.longyu.network`) makes the mainnet app: no testnet label, text or addresses, and the chain check of `chain-check.production.json`. Run the server with the same `APP_VARIANT`. The image takes it as `--build-arg APP_VARIANT=production`.

Files ending in `.web.ts` or `.web.tsx` are the browser's versions of the ones beside them; the APK never contains them.
