// Drives the real page in Chromium: run after `npm run build:optimizer`, with the site on BASE.
// Usage: node apps/image-optimizer/test/engine.mjs [baseUrl]
import { chromium } from 'playwright';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, 'samples');
const base = process.argv[2] || 'http://localhost:8080';
const dummy = join(here, 'samples/not-an-image.txt');
writeFileSync(dummy, 'hello, this is not an image at all');

const files = readdirSync(samples)
  .filter((f) => statSync(join(samples, f)).isFile() && !f.startsWith('Screenshot') && !f.startsWith('smoke') && !f.endsWith('.txt'))
  .map((f) => join(samples, f));
files.push(dummy);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
page.on('response', (r) => { if (r.status() >= 400) problems.push(`${r.status()}: ${r.url()}`); });

async function runWith(label, setup) {
  await page.goto(`${base}/tools/image-optimizer/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await setup();
  await page.locator('#pick-files').setInputFiles(files);
  const t0 = Date.now();
  await page.locator('#run').click();
  await page.waitForFunction(() => /^Finished/.test(document.getElementById('progress-label').textContent), null, { timeout: 270000 })
    .catch(async (error) => {
      console.log(`Stuck at: ${await page.locator('#progress-label').textContent()}`);
      console.log(await page.locator('#rows tr').evaluateAll((trs) => trs.map((tr) => tr.textContent.trim().replace(/\s+/g, ' ')).join('\n')));
      console.log(problems.join('\n'));
      throw error;
    });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  const rows = await page.locator('#rows tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim()).join(' | ')));
  console.log(`\n=== ${label}  ${seconds}s  saved ${await page.locator('#total-saved').textContent()}  ${await page.locator('#total-sizes').textContent()}`);
  rows.forEach((r) => console.log(`  ${r}`));
}

const only = process.argv[3];
if (!only || only === 'keep') await runWith('Keep original', async () => {});
if (!only || only === 'resize') await runWith('WebP, max 1600 px', async () => {
  await page.locator('#width').fill('1600');
  await page.locator('#height').fill('1600');
  await page.locator('input[value="webp"]').check({ force: true });
});

await browser.close();
console.log(`\n${problems.length} problems`);
problems.forEach((p) => console.log(`  ${p}`));
process.exitCode = problems.length ? 1 : 0;
