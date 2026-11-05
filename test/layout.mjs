// The page's states: nothing added, one image, a batch, and the resize checkbox.
// Usage: node test/layout.mjs <screenshot folder> [baseUrl]
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const samples = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const shots = process.argv[2];
const base = process.argv[3] || 'http://localhost:8080';
const url = `${base}${process.env.MIO_PATH ?? '/tools/image-optimizer/'}`;
const photo = join(samples, 'david-vilches-azJZZMpTnLo-unsplash.jpg');
const batch = ['dashboard.png', 'credit-flow.png', 'sewing-threads.heic', 'david-vilches-azJZZMpTnLo-unsplash.jpg', 'not-an-image.txt'].map((f) => join(samples, f));

const results = [];
const check = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'pass' : 'FAIL'}  ${name} ${detail}`); };
const browser = await chromium.launch();
const finished = (page) => page.waitForFunction(() => /^Finished/.test(document.getElementById('progress-label').textContent), null, { timeout: 180000 });

for (const [view, options] of [['desktop', { viewport: { width: 1280, height: 900 } }], ['phone', { viewport: { width: 390, height: 844 }, colorScheme: 'dark' }]]) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });

  check(`${view}: options hidden with no files`, !(await page.locator('#options').isVisible()));
  check(`${view}: results hidden with no files`, !(await page.locator('#results').isVisible()));
  await page.screenshot({ path: join(shots, `${view}-1-empty.png`) });

  // One image.
  await page.locator('#pick-files').setInputFiles(photo);
  const animation = await page.locator('#options').evaluate((el) => getComputedStyle(el).animationName);
  check(`${view}: options fade in`, animation === 'mio-reveal', animation);
  check(`${view}: options appear`, await page.locator('#options').isVisible());
  check(`${view}: size boxes hidden until Resize is ticked`, !(await page.locator('#width').isVisible()));
  await page.locator('#resize').check();
  check(`${view}: ticking Resize shows the size boxes`, await page.locator('#width').isVisible() && await page.locator('#height').isVisible());
  await page.locator('#resize').uncheck();
  check(`${view}: unticking Resize hides them`, !(await page.locator('#width').isVisible()));

  await page.locator('#rows img[src]').waitFor({ timeout: 30000 });
  await page.waitForTimeout(300);
  const big = await page.locator('#rows img').evaluate((img) => { const r = img.getBoundingClientRect(); return { w: r.width, h: r.height, natural: img.naturalWidth }; });
  check(`${view}: one image is shown big, from the full file`, big.h > 150 && big.natural === 2133, JSON.stringify(big));
  await page.screenshot({ path: join(shots, `${view}-2-single-ready.png`), fullPage: true });
  await page.locator('#run').click();
  await finished(page);
  const single = await page.locator('#rows tr').first().innerText();
  check(`${view}: one image shows a minus and the amount saved`, /−\d+%/.test(single) && /−\d/.test(single.replace(/−\d+%/, '')), single.replace(/\s+/g, ' '));
  check(`${view}: unchanged format isn't mentioned`, !/JPEG/.test(single));
  check(`${view}: no totals for one image`, !(await page.locator('#totals').isVisible()));
  await page.screenshot({ path: join(shots, `${view}-3-single-done.png`), fullPage: true });
  await page.locator('#rows img').click();
  await page.locator('#compare[open]').waitFor();
  await page.locator('#compare-status').waitFor({ state: 'hidden', timeout: 30000 });
  check(`${view}: selecting the big image opens the comparison`, true);
  await page.keyboard.press('Escape');

  // A batch.
  await page.locator('#clear').click();
  check(`${view}: Clear hides the options again`, !(await page.locator('#options').isVisible()));
  await page.locator('#pick-files').setInputFiles(batch);
  // Thumbnails load as rows come into view.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForFunction(() => document.querySelectorAll('#rows img[src]').length >= 4, null, { timeout: 60000 });
  const thumbs = await page.locator('#rows img[src]').evaluateAll((imgs) => imgs.map((i) => [i.naturalWidth, i.naturalHeight, i.getBoundingClientRect().width]));
  check(`${view}: thumbnails are small files, HEIC included`, thumbs.length === 4 && thumbs.every(([w, h]) => Math.min(w, h) <= 112), JSON.stringify(thumbs));
  await page.screenshot({ path: join(shots, `${view}-4-batch-ready.png`), fullPage: true });

  let sawRunning = false;
  await page.locator('#run').click();
  for (let i = 0; i < 200 && !sawRunning; i++) {
    sawRunning = await page.locator('#rows .mio-row-bar:visible').count() > 0;
    if (!sawRunning) await page.waitForTimeout(50);
  }
  check(`${view}: a running file shows its own progress`, sawRunning);
  await page.screenshot({ path: join(shots, `${view}-5-batch-running.png`), fullPage: true });
  await finished(page);
  const rows = await page.locator('#rows tr').evaluateAll((trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
  rows.forEach((row) => console.log('     ', row));
  check(`${view}: no Format column`, (await page.locator('thead th').allInnerTexts()).every((t) => !/format|notes/i.test(t)));
  check(`${view}: changed format is noted`, rows.some((r) => /sewing.*HEIC → JPEG/.test(r)));
  check(`${view}: unchanged format isn't`, rows.filter((r) => /dashboard|david/.test(r)).every((r) => !/PNG|JPEG/.test(r.replace(/\.png|\.jpg/g, ''))));
  check(`${view}: unsupported file says why`, rows.some((r) => /not-an-image.*Skipped/.test(r)));
  check(`${view}: batch totals show a minus`, /^−\d+%$/.test(await page.locator('#total-saved').textContent()));
  check(`${view}: no sideways page scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(shots, `${view}-6-batch-done.png`), fullPage: true });

  await page.locator('#rows .mio-thumb[data-comparable="true"]').first().click();
  await page.locator('#compare[open]').waitFor();
  check(`${view}: selecting a thumbnail opens the comparison`, true);
  await page.keyboard.press('Escape');

  await page.locator('[data-sort="saved"]').click();
  const order = await page.locator('#rows tr').evaluateAll((trs) => trs.map((tr) => parseInt(/−(\d+)%/.exec(tr.innerText)?.[1] ?? '-1', 10)));
  check(`${view}: sorting by saved works`, order.every((v, i) => i === 0 || order[i - 1] >= v), order.join(','));
  check(`${view}: thumbnails survive sorting`, await page.locator('#rows img[src]').count() === 4);
  check(`${view}: no page errors`, errors.length === 0, errors.join('; '));
  await context.close();
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} of ${results.length} passed`);
process.exitCode = failed ? 1 : 0;
