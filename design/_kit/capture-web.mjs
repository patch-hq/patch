// Capture a real Patch web screen (markup + stylesheet + fonts) from the dev
// harness, as the base for a Pad design. Run from packages/web so Playwright
// resolves:
//
//   cd packages/web && node ../../design/_kit/capture-web.mjs <out-dir> <name> "<harness query>"
//
// Queries: "chat=chat_voice&voice=call" (a call), "chat=chat_md" (markdown),
// "chat=chat_tool_paired" (tool rows). Settings pages need the e2e stub:
// see capture-settings.spec.ts. Starts its own Vite dev server on port 5199.
// Writes <out>/_src/<name>.html (body), <out>/real.css and <out>/fonts/.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [, , outDir, name, query] = process.argv;
if (!outDir || !name || !query) {
  console.error('usage: capture-web.mjs <out-dir> <name> "<harness query>"');
  process.exit(1);
}
const vite = spawn('npx', ['vite', '--port', '5199', '--strictPort'], { stdio: 'ignore' });
try {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  for (let i = 0; ; i++) {
    try { await p.goto(`http://localhost:5199/app/dev-harness.html?${query}`); break; }
    catch (e) { if (i > 30) throw e; await new Promise((r) => setTimeout(r, 1000)); }
  }
  await p.waitForTimeout(2500);
  const css = await p.evaluate(() => [...document.styleSheets]
    .map((s) => { try { return [...s.cssRules].map((r) => r.cssText).join('\n'); } catch { return ''; } }).join('\n'));
  const body = await p.evaluate(() => document.body.innerHTML);
  await b.close();
  fs.mkdirSync(path.join(outDir, '_src'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(outDir, '_src', `${name}.html`), body);
  // Fonts: copy the latin woff2 files next to the CSS so the Pad renders offline.
  const fixed = css.replace(/url\("(\/app\/@fs(\/[^"]+\.woff2?))"\)/g, (_m, _u, file) => {
    const base = path.basename(file);
    if (!/-latin-/.test(base) || /-ext-/.test(base)) return 'url("data:,")';
    fs.copyFileSync(file, path.join(outDir, 'fonts', base));
    return `url("fonts/${base}")`;
  });
  fs.writeFileSync(path.join(outDir, 'real.css'), fixed);
  console.log(`captured ${name} → ${outDir}`);
} finally {
  vite.kill();
}
