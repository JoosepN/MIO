// The tool page. It reads files, calls the engine, and writes results. All image work is in ../engine.
import { createThumbnailer, defaultConcurrency, runBatch, viewableOriginal } from '../engine/index.js';
import { openCompare, setupCompare } from './compare.js';
import { createPacer } from './progress.js';
import './tool.css';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'image-optimizer-settings';
const THUMB_SIZE = 112; // Twice the size it's shown at, for sharp screens.
const PROGRESS_INTERVAL = 100;
const canPickFolder = 'showDirectoryPicker' in window;
const supported = 'OffscreenCanvas' in window; // Safari before 16.4 can't process images in a worker.

const state = {
  items: [], // Each one is a file and, once it has run, its result.
  sort: { key: 'order', dir: 1 },
  running: false,
  batch: null,
  outputDir: null,
  sourceHandles: [],
  mode: null, // 'folder' or 'zip', chosen at the first run
  written: [],
  usedNames: new Set(),
  zipFiles: [],
  overwrite: false,
};

const thumbnails = createThumbnailer(THUMB_SIZE);

// Settings ---------------------------------------------------------------

function readSettings() {
  const number = (el) => { const v = parseInt(el.value, 10); return $('resize').checked && v > 0 ? v : null; };
  return {
    resize: $('resize').checked,
    width: number($('width')),
    height: number($('height')),
    enlarge: !$('no-enlarge').checked,
    convert: document.querySelector('input[name="convert"]:checked').value,
    quality: document.querySelector('input[name="quality"]:checked').value,
    fill: $('fill').value,
  };
}

function saveSettings() {
  try {
    const settings = readSettings();
    // Sizes stay remembered while resizing is off, so ticking it again brings them back.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, width: parseInt($('width').value, 10) || null, height: parseInt($('height').value, 10) || null }));
  } catch { /* Private mode. */ }
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return;
    $('resize').checked = !!saved.resize;
    if (saved.width) $('width').value = saved.width;
    if (saved.height) $('height').value = saved.height;
    $('no-enlarge').checked = !saved.enlarge;
    const radio = document.querySelector(`input[name="convert"][value="${saved.convert}"]`);
    if (radio) radio.checked = true;
    const quality = document.querySelector(`input[name="quality"][value="${saved.quality}"]`);
    if (quality) quality.checked = true;
    if (saved.fill) $('fill').value = saved.fill;
  } catch { /* Fall back to defaults. */ }
}

const updateFillRow = () => {
  $('fill-row').hidden = readSettings().convert !== 'jpeg';
};

const updateResizeRow = () => {
  $('resize-fields').hidden = !$('resize').checked;
};

// Input ------------------------------------------------------------------

let nextId = 0;

function addFile(file, path) {
  state.items.push({ id: nextId++, order: nextId, file, path: path || file.name, ...freshResult(file) });
}

const freshResult = (file) => ({
  status: 'waiting', before: file.size, after: null, format: null, source: null,
  comparable: false, flags: [], blob: null, outputPath: null, progress: 0,
});

function readEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walk(entry, prefix) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    addFile(file, prefix + entry.name);
    return;
  }
  const reader = entry.createReader();
  // readEntries returns batches, so it has to be called until it comes back empty.
  for (let batch = await readEntries(reader); batch.length; batch = await readEntries(reader)) {
    for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
  }
}

async function handleDrop(event) {
  event.preventDefault();
  $('drop').dataset.over = 'false';
  if (state.running) return;
  const dropped = [...event.dataTransfer.items].filter((item) => item.kind === 'file');
  // These have to be collected before the first await, or the browser clears them.
  const entries = dropped.map((item) => item.webkitGetAsEntry());
  const handles = dropped.map((item) => item.getAsFileSystemHandle?.());
  for (const handle of handles) {
    const resolved = await handle;
    if (resolved?.kind === 'directory') state.sourceHandles.push(resolved);
  }
  for (const entry of entries) if (entry) await walk(entry, '');
  filesChanged();
}

function handlePick(event) {
  for (const file of event.target.files) addFile(file, file.webkitRelativePath || file.name);
  event.target.value = '';
  filesChanged();
}

function filesChanged() {
  const count = state.items.length;
  $('file-count').textContent = count ? `${count} ${count === 1 ? 'file' : 'files'} ready` : '';
  $('clear').hidden = !count;
  $('options').hidden = !count;
  buildRows();
  renderResults();
  updateActions();
}

function clearAll() {
  thumbnails.clear();
  for (const item of state.items) releaseImage(item);
  Object.assign(state, { items: [], sourceHandles: [], mode: null, outputDir: null, written: [], zipFiles: [] });
  filesChanged();
  $('progress-wrap').hidden = true;
  $('zip').hidden = true;
  $('output-note').textContent = '';
}

// Output -----------------------------------------------------------------

const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);
const folderOf = (path) => path.slice(0, path.lastIndexOf('/') + 1);
const stem = (name) => (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name);
const extOf = (name) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

// Same filename, only the extension changes when the format does.
// No two files may share a path, or one would replace the other.
function outputPath(item, result) {
  const folder = folderOf(item.path);
  const name = baseName(item.path);
  const original = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const keepsName = !result.extension || (result.sameFormat && ['jpg', 'jpeg', 'png', 'webp'].includes(extOf(name)));
  const extension = keepsName ? original : result.extension;
  const build = (suffix) => `${folder}${stem(name)}${suffix}${extension ? `.${extension}` : ''}`;
  // A converted file also stays clear of the input names, so finishing first can't take another file's name.
  const free = (path) => !state.usedNames.has(path.toLowerCase()) && (keepsName || !state.items.some((other) => other.path.toLowerCase() === path.toLowerCase()));

  if (free(build(''))) return { path: build(''), renamed: false };
  // A format change names the source format, so photo.png becomes photo (png).webp.
  if (!keepsName && extOf(name) && free(build(` (${extOf(name)})`))) return { path: build(` (${extOf(name)})`), renamed: true };
  let copy = 2;
  while (!free(build(` (${copy})`))) copy++;
  return { path: build(` (${copy})`), renamed: true };
}

async function directoryFor(root, path, create) {
  let dir = root;
  for (const part of path.split('/').slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

async function writeToFolder(path, blob) {
  const dir = await directoryFor(state.outputDir, path, true);
  const handle = await dir.getFileHandle(baseName(path), { create: true });
  const stream = await handle.createWritable();
  await stream.write(blob);
  await stream.close();
}

async function exists(root, path) {
  try {
    const dir = await directoryFor(root, path, false);
    await dir.getFileHandle(baseName(path));
    return true;
  } catch {
    return false;
  }
}

// Every name a file could end up with, because the format isn't final until it has been encoded.
async function findExisting(root) {
  for (const { path } of state.items) {
    const candidates = [path, ...['jpg', 'png', 'webp'].map((ext) => `${stem(path)}.${ext}`)];
    for (const candidate of candidates) if (await exists(root, candidate)) return candidate;
  }
  return null;
}

function askOverwrite(example) {
  const dialog = $('overwrite');
  $('overwrite-example').textContent = example;
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'overwrite'), { once: true });
  });
}

async function chooseFolder() {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'image-optimizer-output' });
  } catch {
    return false; // Closed the picker.
  }
  // A dragged folder can be compared exactly. A picked one only gives its name, so a matching name counts.
  const sourceNames = new Set(state.items.filter((item) => item.path.includes('/')).map((item) => item.path.split('/')[0]));
  let isSource = sourceNames.has(dir.name);
  for (const source of state.sourceHandles) isSource ||= await source.isSameEntry(dir);
  if (isSource) {
    $('output-note').textContent = 'Choose a different folder. The output can\'t go into the source folder.';
    return false;
  }
  const existing = await findExisting(dir);
  if (existing && !(await askOverwrite(existing))) return false;
  state.outputDir = dir;
  state.mode = 'folder';
  $('output-note').textContent = `Saving to the “${dir.name}” folder`;
  return true;
}

async function removePreviousOutput() {
  for (const path of state.written) {
    try {
      const dir = await directoryFor(state.outputDir, path, false);
      await dir.removeEntry(baseName(path));
    } catch { /* Already gone. */ }
  }
  state.written = [];
}

// Running ----------------------------------------------------------------

async function run() {
  if (state.running || !state.items.length) return;
  const rerun = state.mode !== null;
  if (!state.mode) state.mode = 'zip';
  start(rerun);
}

async function runToFolder() {
  if (state.running || !state.items.length) return;
  if (await chooseFolder()) start(false);
}

async function start(rerun) {
  state.running = true;
  updateActions();
  if (rerun && state.mode === 'folder') await removePreviousOutput();
  Object.assign(state, { usedNames: new Set(), zipFiles: [] });
  for (const item of state.items) {
    Object.assign(item, freshResult(item.file));
    updateRow(item);
  }
  $('zip').hidden = true;
  $('progress-wrap').hidden = false;
  renderResults();
  updateActions();
  saveSettings();

  let done = 0;
  const total = state.items.length;
  setProgress(0, total);
  $('progress').value = 0;

  // Saving is async, so results are delivered one at a time and "done" waits for the last save.
  let delivering = Promise.resolve();

  const settings = readSettings();
  const concurrency = defaultConcurrency();
  const pacer = createPacer(state.items, settings, Math.min(concurrency, total));
  const ticker = setInterval(() => {
    pacer.tick();
    $('progress').value = pacer.batch;
    for (const item of state.items) {
      if (item.status !== 'running') continue;
      item.progress = pacer.value(item.id);
      drawRowProgress(item);
    }
  }, PROGRESS_INTERVAL);

  state.batch = runBatch(state.items, settings, {
    concurrency,
    onScore: (msPerMP) => pacer.scored(msPerMP),
    onStart: (item) => {
      pacer.start(item.id);
      item.status = 'running';
      updateRow(item);
    },
    onResult: (item, result) => {
      pacer.finish(item.id);
      delivering = delivering.then(async () => {
        await deliver(item, result);
        done++;
        setProgress(done, total);
        updateRow(item);
        renderResults();
      });
    },
    onDone: async ({ cancelled }) => {
      clearInterval(ticker);
      if (!cancelled) $('progress').value = 1;
      await delivering;
      state.running = false;
      state.batch = null;
      for (const item of state.items) {
        if (item.status === 'running') { item.status = 'waiting'; updateRow(item); }
      }
      updateActions();
      renderResults();
      $('progress-label').textContent = cancelled ? `Cancelled after ${done} of ${total}` : `Finished ${total} of ${total}`;
      if (!cancelled && state.mode === 'zip' && state.zipFiles.length) {
        $('zip').hidden = false;
        // Nothing to bundle for one file, so it goes out as it is.
        $('zip').textContent = state.zipFiles.length === 1 ? 'Download the image' : `Download ${state.zipFiles.length} images as ZIP`;
      }
    },
  });
}

async function deliver(item, result) {
  Object.assign(item, {
    status: result.status, before: result.before, after: result.after ?? null,
    format: result.format ?? null, source: result.source ?? null,
    comparable: result.status === 'done' && !result.kept, flags: [],
  });
  if (result.status !== 'done') {
    item.flags.push(result.status === 'skipped' ? `Skipped: ${result.reason}` : `Failed: ${result.reason}`);
    return;
  }

  const blob = result.kept ? item.file : result.blob;
  const { path, renamed } = outputPath(item, result);
  state.usedNames.add(path.toLowerCase());
  item.outputPath = path;
  if (result.kept) item.flags.push('Kept original');
  if (result.after > result.before) item.flags.push('Larger than the original');
  if (result.filled) item.flags.push('Transparency filled');
  if (renamed) item.flags.push('Renamed');

  try {
    if (state.mode === 'folder') {
      await writeToFolder(path, blob);
      state.written.push(path);
    } else {
      state.zipFiles.push({ name: path, input: blob, lastModified: new Date() });
      item.blob = blob;
    }
  } catch (error) {
    item.status = 'failed';
    item.comparable = false;
    item.flags = [`Couldn't save: ${error.message}`];
  }
}

function setProgress(done, total) {
  $('progress-label').textContent = `${done} of ${total}`;
}

const drawRowProgress = (item) => item.bar?.style.setProperty('--mio-row-progress', item.progress);

async function downloadZip() {
  let blob;
  let name;
  if (state.zipFiles.length === 1) {
    blob = state.zipFiles[0].input;
    name = baseName(state.zipFiles[0].name);
  } else {
    const { downloadZip: zip } = await import('client-zip');
    blob = await zip(state.zipFiles).blob();
    name = 'optimized-images.zip';
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

function updateActions() {
  const has = state.items.length > 0;
  const finished = state.items.some((item) => item.status !== 'waiting');
  $('run').disabled = !has || state.running || !supported;
  $('run').textContent = finished && !state.running ? 'Run again' : 'Run';
  $('folder-instead').hidden = !canPickFolder || !has || state.running || state.mode !== null;
  $('cancel').hidden = !state.running;
  $('clear').hidden = !has || state.running;
}

// Previews ---------------------------------------------------------------

function showImage(item, blob) {
  if (!blob || !item.image?.isConnected) return;
  if (item.imageUrl) URL.revokeObjectURL(item.imageUrl);
  item.imageUrl = URL.createObjectURL(blob);
  item.image.src = item.imageUrl;
}

function releaseImage(item) {
  if (item.imageUrl) URL.revokeObjectURL(item.imageUrl);
  item.imageUrl = null;
}

// Thumbnails are only made for rows that come into view, so a huge folder costs little up front.
const thumbObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    thumbObserver.unobserve(entry.target);
    const item = state.items.find((candidate) => candidate.image === entry.target);
    if (item) thumbnails.add(item.file).then((blob) => showImage(item, blob));
  }
}, { rootMargin: '200px' });

// Results ----------------------------------------------------------------

function formatSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const savedPercent = (item) => (item.after == null ? null : Math.round((1 - item.after / item.before) * 100));
const FORMAT_LABEL = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP', heic: 'HEIC', avif: 'AVIF', bmp: 'BMP' };
const MINUS = '−';

const SORTERS = {
  order: (item) => item.order,
  name: (item) => item.path.toLowerCase(),
  after: (item) => item.after ?? -1,
  saved: (item) => savedPercent(item) ?? -1,
};

function sortedItems() {
  const { key, dir } = state.sort;
  const by = SORTERS[key];
  return [...state.items].sort((a, b) => (by(a) > by(b) ? dir : by(a) < by(b) ? -dir : 0));
}

// Folder output is read back from disk, so a large batch doesn't stay in memory just in case.
async function outputOf(item) {
  if (item.blob) return item.blob;
  const dir = await directoryFor(state.outputDir, item.outputPath, false);
  const handle = await dir.getFileHandle(baseName(item.outputPath));
  return handle.getFile();
}

function compareItem(item) {
  openCompare({
    title: baseName(item.outputPath),
    before: viewableOriginal(item.file),
    after: outputOf(item),
    beforeLabel: `Original · ${FORMAT_LABEL[item.source] ?? ''} · ${formatSize(item.before)}`,
    afterLabel: `Optimized · ${FORMAT_LABEL[item.format] ?? ''} · ${formatSize(item.after)}`,
  });
}

function buildRows() {
  const single = state.items.length === 1;
  document.querySelector('.mio').dataset.single = String(single);
  thumbObserver.disconnect();
  $('rows').replaceChildren(...sortedItems().map((item) => {
    const tr = document.createElement('tr');

    const file = document.createElement('td');
    const layout = document.createElement('div');
    layout.className = 'mio-file';

    const thumb = document.createElement('div');
    thumb.className = 'mio-thumb';
    thumb.addEventListener('click', () => { if (item.comparable) compareItem(item); });
    const image = document.createElement('img');
    image.alt = '';
    if (item.imageUrl && !single && item.imageIsThumb) image.src = item.imageUrl;
    thumb.append(image);
    item.image = image;

    const text = document.createElement('div');
    text.className = 'mio-file-text';
    item.nameSlot = document.createElement('div');
    item.notes = document.createElement('p');
    item.notes.className = 'mio-notes';
    item.bar = document.createElement('span');
    item.bar.className = 'mio-row-bar';
    text.append(item.nameSlot, item.notes, item.bar);

    layout.append(thumb, text);
    file.append(layout);
    item.thumb = thumb;

    item.sizes = document.createElement('td');
    item.sizes.className = 'mio-sizes';
    item.saved = document.createElement('td');

    tr.append(file, item.sizes, item.saved);
    updateRow(item);

    if (single) {
      // One image is shown large, so it uses the original rather than a thumbnail.
      item.imageIsThumb = false;
      viewableOriginal(item.file).then((blob) => showImage(item, blob)).catch(() => {});
    } else if (!(item.imageUrl && item.imageIsThumb)) {
      item.imageIsThumb = true;
      thumbObserver.observe(image);
    }
    return tr;
  }));
}

function updateRow(item) {
  if (!item.nameSlot) return;
  const folder = folderOf(item.path);
  const name = baseName(item.path);
  const parts = [];
  if (folder) {
    const span = document.createElement('span');
    span.className = 'mio-path';
    span.textContent = folder;
    parts.push(span);
  }
  if (item.comparable) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'mio-focus mio-name';
    open.textContent = name;
    open.setAttribute('aria-label', `Compare ${name} with the original`);
    open.addEventListener('click', () => compareItem(item));
    parts.push(open);
  } else {
    parts.push(name);
  }
  item.nameSlot.replaceChildren(...parts);
  item.thumb.dataset.comparable = String(item.comparable);

  // The format only matters when it changed. Otherwise there's nothing to add.
  const notes = [...item.flags];
  if (item.format && item.source && item.format !== item.source) notes.unshift(`${FORMAT_LABEL[item.source]} → ${FORMAT_LABEL[item.format]}`);
  item.notes.textContent = notes.join(' · ');
  item.notes.hidden = !notes.length;
  item.bar.hidden = item.status !== 'running';
  drawRowProgress(item);

  item.sizes.textContent = item.after == null ? formatSize(item.before) : `${formatSize(item.before)} → ${formatSize(item.after)}`;

  const percent = savedPercent(item);
  const savedParts = [];
  if (item.status === 'waiting' && state.running) savedParts.push(savedLine('mio-saved-amount', 'Waiting'));
  else if (item.status === 'running') savedParts.push(savedLine('mio-saved-amount', 'Optimizing'));
  else if (percent !== null) {
    const amount = item.before - item.after;
    if (amount === 0) savedParts.push(savedLine('mio-saved-amount', 'No change'));
    else {
      const sign = amount > 0 ? MINUS : '+';
      savedParts.push(savedLine('mio-saved-percent', `${sign}${Math.abs(percent) || '<1'}%`));
      savedParts.push(savedLine('mio-saved-amount', `${sign}${formatSize(Math.abs(amount))}`));
    }
  }
  item.saved.replaceChildren(...savedParts);
}

function savedLine(className, text) {
  const line = document.createElement('span');
  line.className = className;
  line.textContent = text;
  return line;
}

function renderResults() {
  const count = state.items.length;
  $('results').hidden = !count;
  if (!count) return;

  const single = count === 1;
  const processed = state.items.filter((item) => item.after != null);
  const before = processed.reduce((sum, item) => sum + item.before, 0);
  const after = processed.reduce((sum, item) => sum + item.after, 0);
  $('totals').hidden = single || !processed.length;
  const percent = before ? Math.round((1 - after / before) * 100) : 0;
  $('total-saved').textContent = percent > 0 ? `${MINUS}${percent}%` : percent < 0 ? `+${-percent}%` : '0%';
  $('total-sizes').textContent = `${formatSize(before)} → ${formatSize(after)}`;
  const problems = state.items.filter((item) => item.status === 'skipped' || item.status === 'failed').length;
  $('total-count').textContent = `${processed.length} ${processed.length === 1 ? 'image' : 'images'}${problems ? `, ${problems} not processed` : ''}`;

  const comparable = state.items.some((item) => item.comparable);
  $('compare-hint').hidden = !comparable;
  $('compare-hint').textContent = single ? 'Select the image to compare it with the original.' : 'Select an image or its name to compare it with the original.';

  document.querySelectorAll('[data-sort]').forEach((header) => {
    const active = header.dataset.sort === state.sort.key;
    header.closest('th').setAttribute('aria-sort', active ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
  });
}

function setSort(key) {
  state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === 'name' ? 1 : -1 };
  buildRows();
  renderResults();
}

// Wiring -----------------------------------------------------------------

function init() {
  loadSettings();
  updateFillRow();
  updateResizeRow();
  updateActions();
  setupCompare();
  if (!supported) $('output-note').textContent = 'This browser can\'t run the tool. Update it, or use a recent version of Chrome, Edge, Firefox or Safari.';

  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.dataset.over = 'true'; });
  drop.addEventListener('dragleave', () => { drop.dataset.over = 'false'; });
  drop.addEventListener('drop', handleDrop);
  $('pick-files').addEventListener('change', handlePick);
  $('pick-folder').addEventListener('change', handlePick);

  document.querySelectorAll('input[name="convert"], input[name="quality"]').forEach((radio) => radio.addEventListener('change', () => { updateFillRow(); saveSettings(); }));
  ['width', 'height', 'no-enlarge', 'fill'].forEach((id) => $(id).addEventListener('change', saveSettings));
  $('resize').addEventListener('change', () => { updateResizeRow(); saveSettings(); });

  $('run').addEventListener('click', run);
  $('folder-instead').addEventListener('click', runToFolder);
  $('cancel').addEventListener('click', () => state.batch?.cancel());
  $('clear').addEventListener('click', clearAll);
  $('zip').addEventListener('click', downloadZip);
  document.querySelectorAll('[data-sort]').forEach((header) => header.addEventListener('click', () => setSort(header.dataset.sort)));
}

init();
