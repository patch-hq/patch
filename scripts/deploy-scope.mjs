// Paths that can change what the browser layer of the test gate would report.
// Releases are built and published by GitHub Actions (.github/workflows/release.yml);
// nothing here ships anything.
export const BROWSER_GATE_PATHS = ['packages/web/', 'packages/wire/'];
