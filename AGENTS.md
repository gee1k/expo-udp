# AGENTS.md

This repository contains `@isvend/expo-udp`, an Expo SDK 56 native module for UDP sockets on iOS and Android.

Before changing Expo module code, check the versioned Expo documentation for SDK 56:

https://docs.expo.dev/versions/v56.0.0/

## Boundaries

- Keep the package focused on low-level UDP primitives.
- Do not add app-wide services, business protocol parsers, JSON/Zod routers, or global singleton managers to the core package.
- `useUdpSocket` is a thin page-local lifecycle helper only.
- npm package name: `@isvend/expo-udp`.
- Native module name: `ExpoUdp`.
- Android package/namespace: `expo.modules.udp`.

## Verification

Run these checks before publishing or after native/API changes:

```sh
npm test -- --runInBand --watchman=false src/__tests__/ExpoUdp.test.ts
npm run build
npm run lint
cd example && npx tsc --noEmit
cd example/android && ./gradlew :isvend-expo-udp:compileDebugKotlin
xcodebuild -workspace example/ios/expoudpexample.xcworkspace -scheme ExpoUdp -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build
npm_config_cache=/private/tmp/expo-udp-npm-cache npm pack --dry-run --json --ignore-scripts
```

Broadcast and multicast are implemented but should be validated on physical devices and target networks before claiming production coverage for those scenarios.
