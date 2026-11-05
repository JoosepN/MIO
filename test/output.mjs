// Rotation, transparency fill, folder output (structure, overwrite prompt, Run again) and cancel.
// showDirectoryPicker can't open in a headless browser, so it returns a real private-storage folder.
// Usage: node apps/image-optimizer/test/output.mjs <scratch dir> [baseUrl]
import { chromium } from 'playwright';
import sharp from 'sharp';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const scratch = process.argv[2];
const base = process.argv[3] || 'http://localhost:8080';
rmSync(scratch, { recursive: true, force: true });
const tree = join(scratch, 'shoot');
mkdirSync(join(tree, 'day-1', 'raw'), { recursive: true });

const noise = (w, h, channels) => {
  const data = Buffer.alloc(w * h * channels);
  for (let i = 0; i < data.length; i++) data[i] = (Math.sin(i / 37) + 1) * 90 + (i % 7) * 8;
  if (channels === 4) for (let i = 3; i < data.length; i += 4) data[i] = i % 3200 < 1600 ? 0 : 255;
  return sharp(data, { raw: { width: w, height: h, channels } });
};

const rotated = join(scratch, 'rotated.jpg');
await noise(1200, 800, 3).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toFile(rotated);
console.log('rotated input orientation tag:', (await sharp(rotated).metadata()).orientation);

const clear = join(scratch, 'clear.png');
await noise(800, 800, 4).png().toFile(clear);

await noise(600, 400, 3).jpeg({ quality: 92 }).toFile(join(tree, 'a.jpg'));
await noise(600, 400, 3).jpeg({ quality: 92 }).toFile(join(tree, 'day-1', 'b.jpg'));
await noise(600, 400, 3).jpeg({ quality: 92 }).toFile(join(tree, 'day-1', 'raw', 'c.jpg'));
writeFileSync(join(tree, 'day-1', 'notes.txt'), 'plain text, should be skipped and not copied');

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1200, height: 1000 } });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
await page.addInitScript(() => {
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('output', { create: true });
  };
});

// The label still says Finished from the previous run, so it's cleared before starting a new one.
const clearLabel = () => page.locator('#progress-label').evaluate((el) => { el.textContent = ''; });
const clickRun = async () => { await clearLabel(); await page.locator('#run').click(); };
const clickFolder = async () => { await clearLabel(); await page.locator('#folder-instead').click(); };
const finished = () => page.waitForFunction(() => /^(Finished|Cancelled)/.test(document.getElementById('progress-label').textContent), null, { timeout: 120000 });
const open = async () => { await page.goto(`${base}${process.env.MIO_PATH ?? '/tools/image-optimizer/'}`); await page.evaluate(() => localStorage.clear()); await page.reload(); };
const listOutput = () => page.evaluate(async () => {
  const out = [];
  const walk = async (dir, prefix) => {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') await walk(handle, `${prefix}${name}/`);
      else out.push(`${prefix}${name} (${(await handle.getFile()).size})`);
    }
  };
  const root = await navigator.storage.getDirectory();
  await walk(await root.getDirectoryHandle('output', { create: true }), '');
  return out.sort();
});
const rows = () => page.locator('#rows tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim()).join(' | ')));

async function zipOne(file, name, setup) {
  await open();
  await page.locator('#pick-files').setInputFiles(file);
  await setup();
  await page.locator('#run').click();
  await finished();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#zip').click()]);
  const path = join(scratch, name);
  await download.saveAs(path);
  const m = await sharp(path).metadata();
  console.log(`${name}: ${m.format} ${m.width}x${m.height} alpha:${m.hasAlpha} orientation:${m.orientation ?? '-'} | ${(await rows()).join('')}`);
  return path;
}

// EXIF 6 means 1200x800 pixels display as 800x1200.
await zipOne(rotated, 'rotated-out.jpg', async () => {});

// Green fill, so a corner pixel that was transparent proves it.
const filled = await zipOne(clear, 'filled-out.jpg', async () => {
  await page.locator('input[value="jpeg"]').check({ force: true });
  await page.locator('#fill').evaluate((el) => { el.value = '#00ff00'; el.dispatchEvent(new Event('change')); });
});
const { data } = await sharp(filled).raw().toBuffer({ resolveWithObject: true });
console.log('first pixel of a transparent area:', [...data.subarray(0, 3)]);

// Folder output.
await open();
await page.locator('#pick-folder').setInputFiles(tree);
await clickFolder();
await finished();
console.log('\nFirst run:\n ', (await rows()).join('\n  '));
console.log('Output folder:\n ', (await listOutput()).join('\n  '));

// Run again with a new format has to replace the previous output, not sit next to it.
await page.locator('input[value="webp"]').check({ force: true });
await clickRun();
await finished();
console.log('After Run again as WebP:\n ', (await listOutput()).join('\n  '));

// A new session pointing at the same folder must ask once.
await open();
await page.locator('#pick-folder').setInputFiles(tree);
await page.locator('input[value="webp"]').check({ force: true });
await clickFolder();
await page.locator('#overwrite[open]').waitFor();
console.log('\nOverwrite prompt shown, naming:', await page.locator('#overwrite-example').textContent());
await page.locator('#overwrite button[value="cancel"]').click();
await page.waitForTimeout(300);
console.log('After Cancel, run started:', await page.locator('#progress-wrap').isVisible());
await clickFolder();
await page.locator('#overwrite button[value="overwrite"]').click();
await finished();
console.log('After Overwrite all:', await page.locator('#progress-label').textContent());

// Cancel mid-batch.
await open();
const manyFiles = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.jpg`, mimeType: 'image/jpeg', buffer: null }));
const big = await noise(2400, 1600, 3).jpeg({ quality: 92 }).toBuffer();
manyFiles.forEach((f) => { f.buffer = big; });
await page.locator('#pick-files').setInputFiles(manyFiles);
await page.locator('#run').click();
await page.waitForTimeout(800);
await page.locator('#cancel').click();
await finished();
console.log('\nCancel:', await page.locator('#progress-label').textContent(), '| Run enabled:', await page.locator('#run').isEnabled());

await browser.close();
console.log(`\n${problems.length} page errors`, problems);
