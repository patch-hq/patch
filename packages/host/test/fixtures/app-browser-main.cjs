// The Patch app's agent browser (packages/desktop/src/agent-browser.ts) alone in Electron, for app-browser.test.ts.
const { app } = require('electron');
const { AgentBrowser } = require(process.env.DESKTOP_DIST + '/agent-browser.js');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(async () => {
  const ab = new AgentBrowser({
    endpointFile: process.env.ENDPOINT_FILE,
    appPath: process.execPath,
    version: 'test',
    log: (m, e) => console.log(m, e ?? ''),
    onUserInput: () => {},
  });
  await ab.start();
  console.log('AGENT BROWSER UP');
});
app.on('window-all-closed', () => {});
