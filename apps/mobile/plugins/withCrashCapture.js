// Expo config plugin: native crash capture. PatchCrashModule installs an
// uncaught-exception handler (from MainApplication.onCreate) that writes the
// stack to disk, and hands it to JS on the next launch (src/lib/crashReport.ts).
// Writes the module + package and registers the package (not autolinked), same
// pattern as withImagePaste.js. Plain JS so Expo's plugin resolver can require it.

const fs = require('fs');
const path = require('path');
const { withDangerousMod, withMainApplication } = require('expo/config-plugins');

const PKG_PATH = 'io/github/tomchambers2/patch';
const FILES = ['PatchCrashModule.kt', 'PatchCrashPackage.kt'];

const withNativeFiles = (config) =>
  withDangerousMod(config, [
    'android',
    (cfg) => {
      const javaDir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/java', PKG_PATH);
      fs.mkdirSync(javaDir, { recursive: true });
      for (const f of FILES) {
        fs.writeFileSync(path.join(javaDir, f), fs.readFileSync(path.join(__dirname, 'native', f)));
      }
      return cfg;
    },
  ]);

const withRegistration = (config) =>
  withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (!src.includes('PatchCrashPackage()')) {
      src = src.replace(
        /val packages = PackageList\(this\)\.packages\n/,
        'val packages = PackageList(this).packages\n' +
          '            // Native crash capture (not autolinked) — see plugins/withCrashCapture.js.\n' +
          '            packages.add(PatchCrashPackage())\n',
      );
      if (!src.includes('PatchCrashPackage()')) {
        throw new Error(
          'withCrashCapture: could not register PatchCrashPackage in MainApplication.kt — ' +
            'the getPackages() anchor changed.',
        );
      }
    }
    if (!src.includes('PatchCrashModule.install(')) {
      src = src.replace(
        /override fun onCreate\(\) \{\n\s*super\.onCreate\(\)\n/,
        (m) => `${m}    PatchCrashModule.install(this)\n`,
      );
      if (!src.includes('PatchCrashModule.install(')) {
        throw new Error(
          'withCrashCapture: could not install the handler in MainApplication.onCreate — ' +
            'the onCreate anchor changed.',
        );
      }
    }
    cfg.modResults.contents = src;
    return cfg;
  });

module.exports = (config) => withRegistration(withNativeFiles(config));
