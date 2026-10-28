# Patch on iPhone

Status: the build pipeline and config are prepared and unverified; nothing can be built until an Apple Developer account exists. Nothing here has been run on a Mac or a phone.

## What is ready

- `apps/mobile/app.config.ts` declares iOS (bundle id `io.github.tomchambers2.patch`, usage strings, background audio and remote notification modes). The `ios/` project is generated in CI and never committed.
- `apps/mobile/eas.json` has an `ios` build profile.
- `.github/workflows/ios.yml` builds on a macOS runner and uploads to TestFlight. Manual trigger only; it fails naming the first missing secret.
- `apps/mobile/__tests__/iosConfig.test.ts` guards the config and that Android-only native modules stay behind platform checks.

## The blocker: Tom enrols

1. Enrol in the Apple Developer Program (99 USD/year) at developer.apple.com.
2. Register the App ID `io.github.tomchambers2.patch` with Push Notifications enabled, and create the app in App Store Connect.
3. Create an Apple Distribution certificate and an App Store provisioning profile for it; export the certificate as .p12.
4. Create an App Store Connect API key (Admin or App Manager).
5. Create an iOS app in the app's Firebase project and download GoogleService-Info.plist; upload the APNs key to Firebase for push.
6. Add the secrets listed at the top of `ios.yml` to the GitHub repo (base64 the files) and run the workflow. Store them in the Agents vault too.
7. Install TestFlight on the phone and accept the invite.

## Work that remains after enrolment (native, needs a Mac or CI to verify)

On iOS the Android-only native modules report absent and their features are off, as designed. Each needs a Swift counterpart to reach parity (spec/15 lists the parity rule):

- Voice mic and TTS (PatchVoiceMic, PatchVoiceTts): AVAudioEngine.
- Phone speech recogniser (PatchSpeech): SFSpeechRecognizer.
- Image paste and share sheet (PatchPaste, PatchShare): UIPasteboard and a share extension.
- Crash capture (PatchCrash).
- Incoming Manager call UI: CallKit via react-native-callkeep, plus PushKit for waking the app.
- Over-the-air updates work through expo-updates; the in-app APK installer does not apply, TestFlight replaces it.
- Notification actions (Reply, Approve/Deny) via UNNotificationCategory.

These are tracked as separate tasks in the App updates queue.
