# The Android app offered for download

Before deploying the `mine` service, copy the current release APK here (see `../../BUILD.md`):

```bash
cp "$LONGYU_ANDROID_TOOLS/out/longyu-mine-testnet-<version>-<code>.apk" apps/mobile/site/downloads/
```

- Keep exactly one `.apk` in this folder: the server refuses to start with two.
- It is served at `/download/<its name>`, and `/download/android` always leads to it.
- The file is not committed (`.gitignore`). A deploy without it has no download: both addresses answer 404.
- Publish the APK's SHA-256 wherever the link is given, so people can check what they downloaded.
