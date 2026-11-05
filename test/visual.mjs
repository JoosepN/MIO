// Screenshots of each state of the tool, to compare before and after a styling change.
// Usage: node test/visual.mjs <folder> [url]
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const samples = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const out = process.argv[2];
const url = process.argv[3] || 'http://localhost:8080/tools/image-optimizer/';
const files = ['dashboard.png', 'credit-flow.png'].map((f) => join(samples, f));
const views = [
  { name: 'desktop-light', viewport: { width: 1280, height: 900 }, colorScheme: 'light' },
  { name: 'desktop-dark', viewport: { width: 1280, height: 900 }, colorScheme: 'dark' },
  { name: 'phone-light', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
  { name: 'phone-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
];

const browser = await chromium.launch();
for (const { name, ...options } of views) {
  const context = await browser.newContext({ ...options, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
  await page.evaluate(() => document.fonts.ready);
  const shot = (state) => page.screenshot({ path: join(out, `${name}-${state}.png`), fullPage: state !== 'compare' && state !== 'overwrite' });

  await shot('empty');
  await page.locator('#pick-files').setInputFiles(files);
  await page.waitForTimeout(1500);
  await shot('ready');
  await page.locator('#resize').check();
  await page.locator('input[name="convert"][value="jpeg"]').check({ force: true });
  await shot('options-open');
  await page.locator('#resize').uncheck();
  await page.locator('input[name="convert"][value="keep"]').check({ force: true });
  await page.locator('#run').click();
  await page.waitForFunction(() => /^Finished/.test(document.getElementById('progress-label').textContent), null, { timeout: 120000 });
  await page.locator('#rows button').first().waitFor();
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await shot('results');
  await page.locator('#rows button', { hasText: 'dashboard' }).click();
  await page.locator('#compare-status').waitFor({ state: 'hidden' });
  await page.mouse.move(0, 0);
  await shot('compare');
  await context.close();
}
await browser.close();
console.log('saved to', out);
