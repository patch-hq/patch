// The first-run page is a static file the shell loads straight off disk; it rides
// in dist/ beside main.js (electron-builder packs dist/**).
const { copyFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
for (const f of ['setup.html', 'fraunces.woff2', 'figtree.woff2']) {
  copyFileSync(join(root, 'src/setup', f), join(root, 'dist', f));
}
