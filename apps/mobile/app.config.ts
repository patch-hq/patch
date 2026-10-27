// Expo dynamic config. Replaces app.json so we can:
// - Wire react-native-callkeep config plugin (ConnectionService).
// - Pin Android-only platform (iOS out of scope per spec/15).
//
// NO FALLBACK on FCM: google-services.json must be present for `expo
// prebuild` to wire FCM. We deliberately reference it here so a missing
// file fails the build loudly (per spec/09 push channel rules).

import type { ExpoConfig } from 'expo/config';

const EAS_PROJECT_ID = '07ef948a-199a-4689-ad8b-24d6b87300c4';

const config: ExpoConfig = {
  name: 'Patch',
  slug: 'patch',
  version: '0.1.8',
  icon: './assets/icon.png',
  orientation: 'portrait',
  scheme: 'patch',
  userInterfaceStyle: 'automatic',
  platforms: ['android'],
  // OTA updates (spec/11 § Mobile updates). JS-only changes ship as a signed
  // update the phone fetches from its own server, without a new APK. `runtimeVersion` is the compatibility key: an update is
  // only delivered to a build whose runtime matches, so a native change (bump
  // this literal) correctly forces a fresh APK instead of a broken OTA.
  //
  // PINNED LITERAL, deliberately NOT `{ policy: 'appVersion' }`. With the
  // `appVersion` policy the runtime is derived from the app version — and
  // eas.json sets `appVersionSource: 'remote'` while the APK is built locally via
  // gradle (`pnpm build:android`, not `eas build`). That split let the runtime
  // `eas update` publishes under drift from the `0.1.0` baked into the installed
  // APK, and a runtime mismatch makes EAS SILENTLY withhold the update — the app
  // checks, finds "nothing available", and keeps running old JS. A fixed string
  // makes both the APK's baked runtime and every `eas update` publish exactly
  // the same string, so OTAs are actually delivered. Keep this in lockstep
  // with `version` above; bump both together when a native change needs a
  // fresh APK.
  //
  // Bumped to 0.1.1 for the share-sheet intent-filter + PatchShare native
  // module (plugins/withShareIntent.js): the new JS calls that module
  // unconditionally at bootstrap (src/lib/nativeShare.ts, NO FALLBACK), so it
  // must never reach a phone still running the 0.1.0 APK via OTA.
  //
  // Bumped to 0.1.2 for react-native-webview (the host terminal, spec/15 § Host
  // files and terminal): its native view is not in a 0.1.1 APK, so the JS that
  // draws it must not reach one by OTA.
  //
  // Bumped to 0.1.3 for PatchPaste (plugins/withImagePaste.js): the composer
  // asks that module to take image paste / keyboard image insertion and throws
  // when it is missing (NO FALLBACK), so this JS must not reach a 0.1.2 APK.
  //
  // Bumped to 0.1.4 for PatchCrash (plugins/withCrashCapture.js): startup asks
  // that module for the last native crash and throws when it is missing (NO
  // FALLBACK), so this JS must not reach a 0.1.3 APK.
  //
  // Bumped to 0.1.5 for headset routing in VoiceAudioService (communication mode
  // + setCommunicationDevice): native, so it needs a fresh APK.
  //
  // Bumped to 0.1.6 for updates from the phone's own server (spec/11 § Mobile
  // updates): code signing, the runtime update-URL override, and installing a
  // downloaded APK (expo-intent-launcher, REQUEST_INSTALL_PACKAGES).
  //
  // Bumped to 0.1.7 for the native Android theme: AppTheme is DayNight with
  // night-qualified window/status-bar colours, re-applied by MainActivity on a
  // scheme switch (uiMode is handled in-process). Native, so it needs a fresh APK.
  //
  // Bumped to 0.1.8 for PatchSpeech (the phone's own recogniser for dictation)
  // and the mic tap that feeds it: the phone engine throws when the module is
  // missing (NO FALLBACK), so this JS must not reach a 0.1.7 APK.
  runtimeVersion: '0.1.8',
  updates: {
    // Never contacted. The app points the updater at ITS server once paired
    // (src/lib/otaUpdates.ts), and nothing checks before that: there is no
    // check on launch, and the JS only checks once a launch is running with
    // that address. expo-updates needs a build-time URL to be enabled at all.
    url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
    // The JS decides when to check (it knows the server's address, the native
    // launch does not). A fetched update is LAUNCHED at the next cold start,
    // never swapped into the running app — spec/11 "NO automatic reload".
    checkAutomatically: 'NEVER',
    fallbackToCacheTimeout: 0,
    // Required by the runtime URL override. What it gives up — dropping a
    // downloaded update when the URL changes — matters for an update source
    // nobody vouches for; here every update must carry CI's signature (below),
    // and expo-updates still rolls back an update that crashes on launch.
    disableAntiBrickingMeasures: true,
    // Only an update signed with the release key is accepted
    // (scripts/build-mobile-update.mjs). The certificate is public; its key
    // is the CI secret PATCH_UPDATE_SIGNING_KEY.
    codeSigningCertificate: './certs/certificate.pem',
    codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' },
  },
  // Both native-Android chrome that paints before any JS runs. Without these,
  // Expo defaults both to plain white — visible as a white flash on cold start
  // (the OS splash activity) and as a permanent white strip above the app's own
  // cream/near-black safe-area inset (the status bar). `colors.paper` (light
  // mode) is the closest single value that matches the app background in the
  // common case; dark-mode users still see one correctly-colored frame instead
  // of a flash, which is the actual bug being fixed.
  androidStatusBar: {
    backgroundColor: '#ebe7dc',
    barStyle: 'dark-content',
  },
  android: {
    package: 'io.github.tomchambers2.patch',
    versionCode: 1,
    googleServicesFile: './google-services.json',
    // Adaptive launcher icon (spec/15 § App icon). A circular green icon: the
    // foreground is the tile green drawn as a disc (with the "p") on a
    // transparent canvas and there is no background layer, so whatever shape
    // the launcher masks to, the icon stays a circle.
    adaptiveIcon: {
      foregroundImage: './assets/launcher-icon.png',
      monochromeImage: './assets/adaptive-icon-monochrome.png',
      backgroundColor: '#00000000',
    },
    permissions: [
      'INTERNET',
      'RECORD_AUDIO',
      'MODIFY_AUDIO_SETTINGS',
      'BLUETOOTH',
      'BLUETOOTH_CONNECT',
      'CAMERA',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_MICROPHONE',
      'FOREGROUND_SERVICE_PHONE_CALL',
      'POST_NOTIFICATIONS',
      'BIND_TELECOM_CONNECTION_SERVICE',
      'CALL_PHONE',
      'READ_PHONE_STATE',
      'MANAGE_OWN_CALLS',
      'WAKE_LOCK',
      'VIBRATE',
      // Hand a downloaded APK to Android's installer (spec/11 § Mobile updates).
      // Android still asks the user to confirm every install.
      'REQUEST_INSTALL_PACKAGES',
    ],
  },
  plugins: [
    'expo-router',
    [
      // Pin the Android Kotlin toolchain to 1.9.24 — the version
      // React Native 0.76.3 ships in its gradle version catalog. The
      // Expo prebuild template otherwise writes kotlinVersion 1.9.25,
      // which makes expo-modules-core resolve Compose Compiler 1.5.15
      // (requires Kotlin 1.9.25) while the actual kotlin-gradle-plugin
      // compiling the module is RN's 1.9.24 → fatal "Compose Compiler
      // 1.5.15 requires Kotlin 1.9.25 but you appear to be using 1.9.24"
      // in :expo-modules-core:compileReleaseKotlin. NO FALLBACK: an
      // explicit, build-verified pin rather than relying on the template.
      'expo-build-properties',
      {
        android: {
          kotlinVersion: '1.9.24',
        },
      },
    ],
    [
      'expo-camera',
      {
        cameraPermission: 'Patch needs the camera to scan pairing QR codes.',
      },
    ],
    [
      'expo-notifications',
      {
        color: '#3a5e2c',
        // The urgent rung's sound (spec/09 § Reaching the user), played by the
        // `patch_urgent_alert` channel. This is a bare workflow, so the file is
        // ALSO committed at android/app/src/main/res/raw/ — without a prebuild
        // this list alone puts nothing in the APK.
        sounds: ['./assets/sounds/patch_urgent.wav'],
      },
    ],
    './plugins/withConnectionService',
    './plugins/withShareIntent',
    './plugins/withImagePaste',
    './plugins/withCrashCapture',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#ebe7dc',
        image: './assets/adaptive-icon.png',
        // Android's SplashScreen API (API 31+) always masks this icon to a
        // circle 192dp in diameter within a 288dp canvas — NOT a square. A
        // full-bleed square logo (adaptive-icon.png has no safe-zone padding,
        // by design, since it's meant for a launcher mask) needs a width no
        // greater than 192/sqrt(2) ≈ 136dp to keep all four corners inside
        // that circle. 160 put the corners outside it, so the green square's
        // corners were clipped off on cold start — the "edges cut off" bug.
        imageWidth: 130,
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    eas: {
      projectId: EAS_PROJECT_ID,
    },
  },
};

export default config;
