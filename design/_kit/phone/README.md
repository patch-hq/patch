# Phone screens

The Android app runs on a headless emulator against the local test stack, with
test data and no real account:

1. `docker compose -f docker-compose.test.yml up -d --build` (repo root).
2. Mint a phone login (valid one hour):
   `docker compose -f docker-compose.test.yml exec -T server node dist/scripts/mint-surface-jwt.js --account patch-test --surface emu-phone --kind mobile --data-dir /data`
   then `docker compose -f docker-compose.test.yml restart server` (it reads logins at start).
3. `$ANDROID_HOME/emulator/emulator -avd patch-smoke -no-window -no-audio &`, install the APK,
   `pm clear`, then open `patch://x?credential=<credential>&server=http%3A%2F%2F10.0.2.2%3A13000`
   twice (once to pair, once after the first relaunch), then relaunch.
4. Drive with `adb shell input`, find things with `uiautomator dump`, capture with `screencap`.

Known gap: the test server does not serve app updates, so the emulator runs the
APK's built-in code, which can be older than what phones have after updates.
Check Settings → Updates on the emulator before trusting a capture.

`reference/` holds captures to check phone mockups against.
