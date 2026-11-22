// The bundle id installed shells carry (electron-builder.yml `appId`; app-id.test.ts
// holds the two together). The server's launchd agent names it so macOS shows
// that agent as Patch, with Patch's icon, rather than as the `sh` it runs.
export const APP_BUNDLE_ID = 'dev.patchhq.app';

/** What the app is called in its menus and system lists. */
export const APP_NAME = 'Patch';
