// Paths that can change what the browser layer of the test gate would report.
// Releases are built and published by GitHub Actions (.github/workflows/release.yml);
// nothing here ships anything.
//
// The server and host are in it because the load targets (spec/19 § Load
// targets) run the real web app against a real server and host: a change to
// either can move a target without touching a line of the web app.
export const BROWSER_GATE_PATHS = [
  'packages/web/',
  'packages/wire/',
  'packages/server/',
  'packages/host/',
];
