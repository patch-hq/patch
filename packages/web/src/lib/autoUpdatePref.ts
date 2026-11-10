// Synchronous mirror of the "Update automatically" preference for modules
// (api/ws.ts) that cannot statically import the preferences store: that store
// reaches `api/rest.js`, and a static import would drag the REST client into
// every test that only wants the chat store. The store keeps this in step.
let autoUpdate = true;
export const getAutoUpdateHosts = (): boolean => autoUpdate;
export const setAutoUpdateHosts = (next: boolean): void => {
  autoUpdate = next;
};
