# LONGYU MINE

The mining app: one codebase for Android and for browsers (Expo SDK 58, React Native, expo-router).

- **Android:** a signed APK, built locally. See [BUILD.md](BUILD.md).
- **Browser:** the same screens as a static web build, served by the small server in [site/](site/). The layout switches to a side rail and two columns from 1024 px.

## What the app does

- Signs in with X (OAuth 2.0 with PKCE; the API holds the client secret, the app never sees it).
- Creates the user's wallet on the device and keeps the key there: in the Android Keystore on a phone, and in the browser's storage on the web. The key is never sent to the backend. Linking the wallet is a signed SIWE message.
- Starts a 24-hour mining session. A phone proves itself with hardware key attestation; a browser answers a human check instead.
- Shows rewards, capacity plans and the network's statistics, and queues gasless claims.

## Layout

| Path | Contents |
|---|---|
| `src/app/` | Screens (expo-router): onboarding, the four tabs, key export |
| `src/components/` | The UI kit: cards, tables, the pearl dial, navigation |
| `src/design/` | Colour and type tokens; `brand.ts` is written by `brand/tools/build.mjs` |
| `src/lib/` | API client, wallet key handling, sign-in, formatting, translations (English, Simplified and Traditional Chinese) |
| `src/preview/` | A stand-in backend for design previews (`LONGYU_PREVIEW=1`) |
| `site/` | Static server for the web build and the APK download |

Files ending in `.web.ts` or `.web.tsx` are the browser's versions of the files beside them.

## Develop

```sh
npm install --legacy-peer-deps
EXPO_PUBLIC_API_URL=http://localhost:8080 EXPO_PUBLIC_DEV_ATTESTATION=true npx expo start
npm run typecheck
npm test
```

`EXPO_PUBLIC_DEV_ATTESTATION=true` sends a development device check, which only an API started with `ALLOW_DEV_ATTESTATION` accepts. A release build refuses to be made with it.
