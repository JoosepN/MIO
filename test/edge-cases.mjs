// Builds awkward input files, runs them through the real page, and inspects the downloaded output.
// Usage: node apps/image-optimizer/test/edge-cases.mjs <scratch dir> [baseUrl]
import { chromium } from 'playwright';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const scratch = process.argv[2];
const base = process.argv[3] || 'http://localhost:8080';
const inDir = join(scratch, 'in');
const outDir = join(scratch, 'out');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(inDir, { recursive: true });

const noise = (w, h, channels = 3) => {
  const data = Buffer.alloc(w * h * channels);
  for (let i = 0; i < data.length; i++) data[i] = (Math.sin(i / 37) + 1) * 90 + (i % 7) * 8;
  return sharp(data, { raw: { width: w, height: h, channels } });
};

// Tall pixels, rotated to wide by EXIF, with GPS-style metadata attached.
await noise(1200, 800).withExif({ IFD0: { Orientation: '6', Copyright: 'SECRET-METADATA' }, IFD3: { GPSLatitudeRef: 'N' } }).jpeg({ quality: 95 }).toFile(join(inDir, 'rotated.jpg'));

const transparent = Buffer.alloc(600 * 400 * 4);
for (let i = 0; i < transparent.length; i += 4) { transparent[i] = 200; transparent[i + 1] = 30; transparent[i + 2] = 60; transparent[i + 3] = i % 3200 < 1600 ? 0 : 255; }
await sharp(transparent, { raw: { width: 600, height: 400, channels: 4 } }).png().toFile(join(inDir, 'transparent.png'));

await sharp({ create: { width: 4, height: 4, channels: 3, background: '#336699' } }).png().toFile(join(inDir, 'tiny.png'));
await sharp({ create: { width: 64, height: 64, channels: 3, background: '#112233' } }).jpeg({ quality: 20 }).toFile(join(inDir, 'already-small.jpg'));
await noise(500, 500).jpeg({ quality: 90 }).toFile(join(inDir, 'photo.jpg'));
await noise(500, 500).png().toFile(join(inDir, 'photo.png'));
writeFileSync(join(inDir, 'fake.jpg'), 'this is text wearing a jpg extension, long enough to sniff');

const files = readdirSync(inDir).map((f) => join(inDir, f));

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

async function run(name, convert, extra = async () => {}) {
  await page.goto(`${base}${process.env.MIO_PATH ?? '/tools/image-optimizer/'}`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator('#pick-files').setInputFiles(files);
  await page.locator(`input[value="${convert}"]`).check({ force: true });
  await extra();
  await page.locator('#run').click();
  await page.waitForFunction(() => /^Finished/.test(document.getElementById('progress-label').textContent), null, { timeout: 120000 });
  const rows = await page.locator('#rows tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim()).join(' | ')));
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#zip').click()]);
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, '_batch.zip');
  await download.saveAs(zip);
  // Windows' own tar reads ZIPs. The one in Git Bash doesn't, and mistakes C: for a remote host.
  execFileSync(process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'unzip', process.platform === 'win32' ? ['-xf', zip, '-C', dir] : [zip, '-d', dir]);
  rmSync(zip);
  console.log(`\n=== ${name}`);
  rows.forEach((r) => console.log(`  ${r}`));
  // Two outputs with one name would leave fewer files than images after extracting.
  const expected = rows.filter((r) => !r.includes('Skipped')).length;
  if (readdirSync(dir).length !== expected) problems.push(`${name}: ${expected} images but ${readdirSync(dir).length} files`);
  for (const f of readdirSync(dir)) {
    const m = await sharp(join(dir, f)).metadata();
    console.log(`  -> ${f}  ${m.format} ${m.width}x${m.height} ${statSync(join(dir, f)).size}B alpha:${m.hasAlpha} exif:${!!m.exif} icc:${!!m.icc} orient:${m.orientation ?? '-'}`);
  }
}

await run('keep', 'keep');
await run('webp', 'webp');
await run('jpeg-fill', 'jpeg', () => page.locator('#fill').evaluate((el) => { el.value = '#00ff00'; el.dispatchEvent(new Event('change')); }));
await run('smallest', 'smallest');

await browser.close();
console.log(`\n${problems.length} page errors`, problems);
