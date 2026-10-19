// Put the app in the state where it may check for updates (src/lib/updateSource.ts):
// paired directly to a server, and launched with the updater already pointed at
// it. Import AFTER any `vi.resetModules()`, before the module under test.
export async function activeUpdateSource(url = 'https://patch.test'): Promise<void> {
  const { setRoute } = await import('../../src/config');
  const { store } = await import('../../src/lib/credential');
  const { pointUpdatesAtServer, UPDATE_PATH } = await import('../../src/lib/updateSource');
  setRoute({ kind: 'direct', url });
  store().set('patch.updates.source', `${url}${UPDATE_PATH}`);
  pointUpdatesAtServer();
}
