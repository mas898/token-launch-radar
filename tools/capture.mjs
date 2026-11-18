// Screenshot capture for the token radar dashboard. Dev-only: the grader never runs this file.
// It renders the built dashboard in a headless Chromium (Playwright, installed outside this repo)
// and writes the three screenshots the gate needs: the board, a protocol's detail view, and a
// filtered view. Each is a JPEG at 1440x900, kept under the 512 KiB cap.
//
// Usage, from the repository root, after building an output directory with main.ts:
//   node tools/capture.mjs [out-dir] [screenshots-dir]
// Defaults: out-dir is ./out, screenshots-dir is ./screenshots.
//
// Playwright is resolved from the sibling work directory (../token-radar-work/node_modules) via
// createRequire, or from PLAYWRIGHT_REQUIRE when set to a package.json whose node_modules holds it.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..');
const outDir = process.argv[2] ?? join(repoRoot, 'out');
const shotsDir = process.argv[3] ?? join(repoRoot, 'screenshots');

const requireFrom = process.env.PLAYWRIGHT_REQUIRE ?? join(repoRoot, '..', 'token-radar-work', 'package.json');
const { chromium } = createRequire(requireFrom)('playwright');

/** The Chrome binary to drive: an explicit path, the work dir's Chrome for Testing, or Playwright's own. */
function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    join(repoRoot, '..', 'token-radar-work', 'chrome-linux64', 'chrome'),
  ].filter((c) => typeof c === 'string' && c.length > 0);
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined;
}

/** The board's rows, read from the built output, so the views show the entry's own data. */
const board = JSON.parse(readFileSync(join(outDir, 'board.json'), 'utf8')).rows;
if (!Array.isArray(board) || board.length === 0) throw new Error('no board rows in the output directory');

// The detail view opens the rank-1 protocol; the filtered view uses the board's most common category.
const top = [...board].sort((a, b) => a.rank - b.rank)[0];
const categoryCounts = new Map();
for (const row of board) categoryCounts.set(row.category ?? 'Other', (categoryCounts.get(row.category ?? 'Other') ?? 0) + 1);
const topCategory = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];

const pageUrl = pathToFileURL(join(outDir, 'dashboard', 'index.html')).href;

const executablePath = chromeExecutable();
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const views = [
    { name: '01-board.jpg', hash: '', query: 'view=board' },
    { name: '02-detail.jpg', hash: `#p=${encodeURIComponent(top.slug)}`, query: 'view=detail' },
    { name: '03-filtered.jpg', hash: `#category=${encodeURIComponent(topCategory)}`, query: 'view=filtered' },
  ];
  for (const view of views) {
    // A distinct query forces a full reload: a hash-only change would be same-document navigation
    // and the dashboard would never re-read the hash.
    await page.goto(`${pageUrl}?${view.query}${view.hash}`, { waitUntil: 'load' });
    // The dashboard renders synchronously from data.js; wait for the table to exist.
    await page.waitForSelector('table tbody tr', { timeout: 10_000 });
    if (view.hash.startsWith('#p=')) await page.waitForSelector('dialog[open]', { timeout: 10_000 });
    await page.waitForTimeout(400);
    // Adaptive quality: start high, step down until the file fits the gate's cap with margin.
    let quality = 90;
    let shot = null;
    for (;;) {
      shot = await page.screenshot({ type: 'jpeg', quality });
      if (shot.length <= 480_000 || quality <= 55) break;
      quality -= 10;
    }
    const path = join(shotsDir, view.name);
    writeFileSync(path, shot);
    const size = statSync(path).size;
    console.log(`capture: ${view.name} ${size} bytes (quality ${quality}, ${view.hash || 'board view'})`);
    if (size > 524_288) throw new Error(`${view.name} is ${size} bytes, over the 512 KiB cap`);
  }
} finally {
  await browser.close();
}
console.log(`capture: detail slug ${top.slug}, filtered category ${topCategory}`);
