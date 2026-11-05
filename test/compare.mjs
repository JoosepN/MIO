// Comparison view: opens from a row, lines up, divider and panning work, Full size is true to pixels.
// Usage: node apps/image-optimizer/test/compare.mjs <screenshot dir> [baseUrl] [chromium|firefox|webkit]
import * as playwright from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const samples = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const shots = process.argv[2];
const base = process.argv[3] || 'http://localhost:8080';
const engine = process.argv[4] || 'chromium';
const files = ['david-vilches-azJZZMpTnLo-unsplash.jpg', 'sewing-threads.heic'].map((f) => join(samples, f));

const browser = await playwright[engine].launch();
const results = [];
const check = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'pass' : 'FAIL'}  ${name} ${detail}`); };

async function session(options) {
  const context = await browser.newContext({ acceptDownloads: true, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/tools/image-optimizer/`);
  await page.locator('#pick-files').setInputFiles(files);
  await page.locator('#run').click();
  await page.waitForFunction(() => /^Finished/.test(document.getElementById('progress-label').textContent), null, { timeout: 180000 });
  return { page, errors, context };
}

const openRow = async (page, text) => {
  await page.locator('#rows button', { hasText: text }).click();
  await page.locator('#compare-status').waitFor({ state: 'hidden', timeout: 60000 });
};
const info = (page) => page.evaluate(() => {
  const before = document.getElementById('compare-before');
  const after = document.getElementById('compare-after');
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  return {
    before: box(before), after: box(after), frame: box(document.getElementById('compare-frame')),
    handle: box(document.getElementById('compare-handle')), clip: before.style.clipPath,
    natural: [after.naturalWidth, after.naturalHeight], beforeNatural: [before.naturalWidth, before.naturalHeight],
    now: document.getElementById('compare-handle').getAttribute('aria-valuenow'),
    labels: [document.getElementById('compare-label-before').textContent, document.getElementById('compare-label-after').textContent],
    title: document.getElementById('compare-title').textContent,
  };
});

const { page, errors, context } = await session({ viewport: { width: 1280, height: 900 } });
check('Download button offers a ZIP', /as ZIP/.test(await page.locator('#zip').textContent()), await page.locator('#zip').textContent());
await openRow(page, 'david');
let v = await info(page);
console.log('   ', v.title, '|', v.labels.join(' | '), '|', v.natural.join('x'));
check('Fit shows the whole image inside the frame', v.after.w <= v.frame.w + 1 && v.after.h <= v.frame.h + 1);
check('Layers line up', v.before.x === v.after.x && v.before.y === v.after.y && v.before.w === v.after.w && v.before.h === v.after.h);
if (shots) await page.screenshot({ path: join(shots, `compare-fit-${engine}.png`) });

const startClip = v.clip;
await page.mouse.move(v.handle.x + v.handle.w / 2, v.frame.y + 100);
await page.mouse.down();
await page.mouse.move(v.after.x + v.after.w * 0.25, v.frame.y + 100, { steps: 4 });
await page.mouse.up();
v = await info(page);
check('Dragging moves the divider', v.clip !== startClip, `${startClip} -> ${v.clip}`);

await page.locator('#compare-handle').focus();
const nowBefore = Number(v.now);
await page.keyboard.press('ArrowRight');
v = await info(page);
check('Arrow key moves the divider', Number(v.now) > nowBefore, `${nowBefore} -> ${v.now}`);

await page.locator('#compare-zoom').click();
v = await info(page);
check('Full size is one image pixel per screen pixel', Math.abs(v.after.w - v.natural[0]) < 1, `${v.after.w} for ${v.natural[0]}`);
const startX = v.after.x;
const startY = v.after.y;
await page.mouse.move(v.frame.x + 150, v.frame.y + 200);
await page.mouse.down();
await page.mouse.move(v.frame.x + 80, v.frame.y + 120, { steps: 3 });
await page.mouse.up();
v = await info(page);
check('Dragging at full size pans', v.after.x !== startX || v.after.y !== startY);
check('Panning keeps layers lined up', v.before.x === v.after.x && v.before.y === v.after.y);
await page.mouse.move(v.frame.x + 300, v.frame.y + 300);
const yBefore = v.after.y;
await page.mouse.wheel(0, 120);
await page.waitForTimeout(150);
v = await info(page);
check('Scrolling at full size pans', v.after.y !== yBefore);
for (let i = 0; i < 12; i++) await page.mouse.wheel(4000, 4000);
await page.waitForTimeout(150);
v = await info(page);
check('Panning stops at the image edge', v.after.x + v.after.w >= v.frame.x + v.frame.w - 1 && v.after.y + v.after.h >= v.frame.y + v.frame.h - 1);
if (shots) await page.screenshot({ path: join(shots, `compare-full-${engine}.png`) });
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Escape closes it', !(await page.locator('#compare').evaluate((d) => d.open)));
check('Images are released on close', !(await page.locator('#compare-after').getAttribute('src')));

await openRow(page, 'sewing');
v = await info(page);
console.log('   ', v.title, '|', v.labels.join(' | '), '| before', v.beforeNatural.join('x'), 'after', v.natural.join('x'));
check('HEIC original displays', v.beforeNatural[0] > 0);
check('HEIC label is right', /HEIC/.test(v.labels[0]));
if (shots) await page.screenshot({ path: join(shots, `compare-heic-${engine}.png`) });
await page.keyboard.press('Escape');

const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#zip').click()]);
check('Download is a ZIP', download.suggestedFilename().endsWith('.zip'), download.suggestedFilename());
check('No page errors', errors.length === 0, errors.join('; '));
await context.close();

if (engine === 'chromium') {
  const hi = await session({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await openRow(hi.page, 'david');
  await hi.page.locator('#compare-zoom').click();
  v = await info(hi.page);
  check('Full size at 2x screen uses device pixels', Math.abs(v.after.w - v.natural[0] / 2) < 1, `${v.after.w} for ${v.natural[0]}`);
  await hi.context.close();

  const phone = await session({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, colorScheme: 'dark' });
  await phone.page.evaluate(() => document.documentElement.classList.add('dark'));
  await phone.page.locator('#rows button', { hasText: 'david' }).scrollIntoViewIfNeeded();
  if (shots) await phone.page.screenshot({ path: join(shots, 'phone-results.png'), fullPage: true });
  await openRow(phone.page, 'david');
  v = await info(phone.page);
  check('Fits a phone', v.after.w <= 390 && await phone.page.evaluate(() => document.documentElement.scrollWidth <= 390));
  if (shots) await phone.page.screenshot({ path: join(shots, 'phone-compare.png') });
  await phone.context.close();
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${engine}: ${results.length - failed} of ${results.length} passed`);
process.exitCode = failed ? 1 : 0;
