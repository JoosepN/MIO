// The tool page. It reads files, calls the engine, and writes results. All image work is in ../engine.
import { runBatch, viewableOriginal } from '../engine/index.js';
import { openCompare, setupCompare } from './compare.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'image-optimizer-settings';
const canPickFolder = 'showDirectoryPicker' in window;
const supported = 'OffscreenCanvas' in window; // Safari before 16.4 can't process images in a worker.

const state = {
  items: [],
  rows: [],
  skipped: 0,
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

// Settings ---------------------------------------------------------------

function readSettings() {
  const number = (el) => { const v = parseInt(el.value, 10); return v > 0 ? v : null; };
  return {
    width: number($('width')),
    height: number($('height')),
    enlarge: !$('no-enlarge').checked,
    convert: document.querySelector('input[name="convert"]:checked').value,
    quality: document.querySelector('input[name="quality"]:checked').value,
    fill: $('fill').value,
  };
}

function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(readSettings())); } catch { /* Private mode. */ }
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return;
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

// Input ------------------------------------------------------------------

let nextId = 0;
const addFile = (file, path) => state.items.push({ id: nextId++, file, path: path || file.name });

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
  $('file-count').textContent = state.items.length
    ? `${state.items.length} ${state.items.length === 1 ? 'file' : 'files'} ready`
    : '';
  $('clear').hidden = !state.items.length;
  updateActions();
}

function clearAll() {
  Object.assign(state, { items: [], rows: [], skipped: 0, sourceHandles: [], mode: null, outputDir: null, written: [], zipFiles: [] });
  renderResults();
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
function outputPath(item, result) {
  const folder = folderOf(item.path);
  const name = baseName(item.path);
  if (!result.extension || (result.sameFormat && ['jpg', 'jpeg', 'png', 'webp'].includes(extOf(name)))) {
    return { path: folder + name, renamed: false };
  }
  let path = `${folder}${stem(name)}.${result.extension}`;
  let renamed = false;
  if (state.usedNames.has(path.toLowerCase())) {
    path = `${folder}${stem(name)} (${extOf(name)}).${result.extension}`;
    renamed = true;
  }
  return { path, renamed };
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
  Object.assign(state, { rows: [], skipped: 0, usedNames: new Set(), zipFiles: [] });
  $('zip').hidden = true;
  $('progress-wrap').hidden = false;
  renderResults();
  updateActions();
  saveSettings();

  let done = 0;
  const total = state.items.length;
  setProgress(0, total);

  // Saving is async, so results are delivered one at a time and "done" waits for the last save.
  let delivering = Promise.resolve();

  state.batch = runBatch(state.items, readSettings(), {
    onResult: (item, result) => {
      delivering = delivering.then(async () => {
        const row = await deliver(item, result, done);
        done++;
        state.rows.push(row);
        setProgress(done, total);
        renderResults();
      });
    },
    onDone: async ({ cancelled }) => {
      await delivering;
      state.running = false;
      state.batch = null;
      updateActions();
      $('progress-label').textContent = cancelled ? `Cancelled after ${done} of ${total}` : `Finished ${total} of ${total}`;
      if (!cancelled && state.mode === 'zip' && state.zipFiles.length) {
        $('zip').hidden = false;
        // Nothing to bundle for one file, so it goes out as it is.
        $('zip').textContent = state.zipFiles.length === 1 ? 'Download the image' : `Download ${state.zipFiles.length} images as ZIP`;
      }
    },
  });
}

async function deliver(item, result, order) {
  const row = { order, id: item.id, file: item.file, path: item.path, status: result.status, before: result.before, after: result.after ?? null, format: result.format ?? null, source: result.source ?? null, comparable: result.status === 'done' && !result.kept, flags: [] };
  if (result.status !== 'done') {
    row.flags.push(result.status === 'skipped' ? `Skipped: ${result.reason}` : `Failed: ${result.reason}`);
    row.problem = true;
    return row;
  }

  const blob = result.kept ? item.file : result.blob;
  const { path, renamed } = outputPath(item, result);
  state.usedNames.add(path.toLowerCase());
  row.outputPath = path;
  if (result.kept) row.flags.push('Kept original');
  if (result.filled) row.flags.push('Transparency filled');
  if (renamed) row.flags.push('Renamed');

  try {
    if (state.mode === 'folder') {
      await writeToFolder(path, blob);
      state.written.push(path);
    } else {
      state.zipFiles.push({ name: path, input: blob, lastModified: new Date() });
      row.blob = blob;
    }
  } catch (error) {
    row.status = 'failed';
    row.problem = true;
    row.comparable = false;
    row.flags = [`Couldn't save: ${error.message}`];
  }
  return row;
}

function setProgress(done, total) {
  $('progress').value = done;
  $('progress').max = total;
  $('progress-label').textContent = `${done} of ${total}`;
}

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
  $('run').disabled = !has || state.running || !supported;
  $('run').textContent = state.rows.length && !state.running ? 'Run again' : 'Run';
  $('folder-instead').hidden = !canPickFolder || !has || state.running || state.mode !== null;
  $('cancel').hidden = !state.running;
  $('clear').hidden = !has || state.running;
}

// Results ----------------------------------------------------------------

function formatSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const savedPercent = (row) => (row.after == null ? null : Math.round((1 - row.after / row.before) * 100));
const FORMAT_LABEL = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP', heic: 'HEIC', avif: 'AVIF', bmp: 'BMP' };

const SORTERS = {
  order: (r) => r.order,
  name: (r) => r.path.toLowerCase(),
  after: (r) => r.after ?? -1,
  saved: (r) => savedPercent(r) ?? -1,
  format: (r) => r.format ?? '',
};

function sortedRows() {
  const { key, dir } = state.sort;
  const by = SORTERS[key];
  return [...state.rows].sort((a, b) => (by(a) > by(b) ? dir : by(a) < by(b) ? -dir : 0));
}

// Folder output is read back from disk, so a large batch doesn't stay in memory just in case.
async function outputOf(row) {
  if (row.blob) return row.blob;
  const dir = await directoryFor(state.outputDir, row.outputPath, false);
  const handle = await dir.getFileHandle(baseName(row.outputPath));
  return handle.getFile();
}

function compareRow(row) {
  openCompare({
    title: baseName(row.outputPath),
    before: viewableOriginal(row.file),
    after: outputOf(row),
    beforeLabel: `Original · ${FORMAT_LABEL[row.source] ?? ''} · ${formatSize(row.before)}`,
    afterLabel: `Optimized · ${FORMAT_LABEL[row.format] ?? ''} · ${formatSize(row.after)}`,
  });
}

function renderResults() {
  const has = state.rows.length > 0;
  $('results').hidden = !has;
  if (!has) return;

  $('compare-hint').hidden = !state.rows.some((r) => r.comparable);

  const processed = state.rows.filter((r) => r.after != null);
  const before = processed.reduce((sum, r) => sum + r.before, 0);
  const after = processed.reduce((sum, r) => sum + r.after, 0);
  $('total-saved').textContent = before ? `${Math.round((1 - after / before) * 100)}%` : '0%';
  $('total-sizes').textContent = `${formatSize(before)} → ${formatSize(after)}`;
  const problems = state.rows.length - processed.length;
  $('total-count').textContent = `${processed.length} ${processed.length === 1 ? 'image' : 'images'}${problems ? `, ${problems} not processed` : ''}`;

  document.querySelectorAll('[data-sort]').forEach((header) => {
    const active = header.dataset.sort === state.sort.key;
    header.closest('th').setAttribute('aria-sort', active ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
  });

  const body = $('rows');
  body.replaceChildren(...sortedRows().map((row) => {
    const tr = document.createElement('tr');
    tr.className = 'border-t border-zinc-200';
    const folder = folderOf(row.path);
    const saved = savedPercent(row);

    const name = document.createElement('td');
    name.className = 'py-3 pr-4 break-all';
    if (folder) {
      const span = document.createElement('span');
      span.className = 'text-zinc-500';
      span.textContent = folder;
      name.append(span);
    }
    if (row.comparable) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'tool-focus rounded text-left underline underline-offset-2';
      open.textContent = baseName(row.path);
      open.setAttribute('aria-label', `Compare ${baseName(row.path)} with the original`);
      open.addEventListener('click', () => compareRow(row));
      name.append(open);
    } else {
      name.append(baseName(row.path));
    }

    const sizes = document.createElement('td');
    sizes.className = 'py-3 pr-4 whitespace-nowrap';
    sizes.textContent = row.after == null ? formatSize(row.before) : `${formatSize(row.before)} → ${formatSize(row.after)}`;

    const percent = document.createElement('td');
    percent.className = 'py-3 pr-4 font-medium';
    percent.textContent = saved == null ? '—' : `${saved}%`;

    const format = document.createElement('td');
    format.className = 'py-3 pr-4';
    format.textContent = FORMAT_LABEL[row.format] ?? '—';

    const flags = document.createElement('td');
    flags.className = 'py-3 text-sm text-zinc-600';
    flags.textContent = row.flags.join(' · ');

    tr.append(name, sizes, percent, format, flags);
    return tr;
  }));
}

function setSort(key) {
  state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === 'name' || key === 'format' ? 1 : -1 };
  renderResults();
}

// Wiring -----------------------------------------------------------------

function init() {
  loadSettings();
  updateFillRow();
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

  $('run').addEventListener('click', run);
  $('folder-instead').addEventListener('click', runToFolder);
  $('cancel').addEventListener('click', () => state.batch?.cancel());
  $('clear').addEventListener('click', clearAll);
  $('zip').addEventListener('click', downloadZip);
  document.querySelectorAll('[data-sort]').forEach((header) => header.addEventListener('click', () => setSort(header.dataset.sort)));
}

init();
