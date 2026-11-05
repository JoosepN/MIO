// Runs the same files at all three quality levels through the real page, and checks the setting sticks.
// Usage: node apps/image-optimizer/test/quality.mjs [baseUrl]
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const samples = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const base = process.argv[2] || 'http://localhost:8080';
const files = [
  'dashboard.png',
  'david-vilches-azJZZMpTnLo-unsplash.jpg',
  'sewing-threads.heic',
  'queensland-australia-7WVpQhFGUqQ-unsplash.jpg',
].map((f) => join(samples, f));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${base}/tools/image-optimizer/`);
await page.evaluate(() => localStorage.clear());
await page.reload();
console.log('Default level:', await page.locator('input[name="quality"]:checked').inputValue());

for (const convert of ['keep', 'jpeg', 'webp']) {
  for (const quality of ['smaller', 'balanced', 'higher']) {
    await page.goto(`${base}/tools/image-optimizer/`);
    await page.locator(`input[name="convert"][value="${convert}"]`).check({ force: true });
    await page.locator(`input[name="quality"][value="${quality}"]`).check({ force: true });
    await page.locator('#pick-files').setInputFiles(files);
    const t0 = Date.now();
    await page.locator('#run').click();
    await page.waitForFunction(() => /^Finished/.test(document.getElementById('progress-label').textContent), null, { timeout: 200000 });
    const rows = await page.locator('#rows tr').evaluateAll((trs) => trs
      .map((tr) => [tr.children[0].textContent.trim().slice(0, 12), tr.children[1].textContent.trim().split('→')[1]?.trim()])
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, size]) => `${name} ${size}`));
    console.log(`${convert.padEnd(5)} ${quality.padEnd(9)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s  ${rows.join(' | ')}`);
  }
}

await page.locator('input[name="quality"][value="higher"]').check({ force: true });
await page.reload();
console.log('Remembered after reload:', await page.locator('input[name="quality"]:checked').inputValue());

await browser.close();
console.log(`${errors.length} page errors`, errors);
