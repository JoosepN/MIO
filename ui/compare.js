// Before/after view for one image. The original is scaled to the output's size, so both line up.
// Fit shows the whole image, Full size maps one image pixel to one screen pixel.

const $ = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const PAN_STEP = 80;

const view = { zoom: 'fit', split: 0.5, x: 0, y: 0, width: 0, height: 0, urls: [], token: 0, drag: null };

function fitScale(frame, image) {
  return Math.min(frame.width / image.naturalWidth, frame.height / image.naturalHeight, 1);
}

// Full size depends on the screen's pixel ratio, so it's worked out again on every layout.
function layout() {
  const image = $('compare-after');
  if (!image.naturalWidth) return;
  const frame = $('compare-frame').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const scale = view.zoom === 'actual' ? 1 / dpr : fitScale(frame, image);
  view.width = image.naturalWidth * scale;
  view.height = image.naturalHeight * scale;

  const place = (offset, size, room) => (size <= room ? (room - size) / 2 : clamp(offset, room - size, 0));
  view.x = Math.round(place(view.x, view.width, frame.width) * dpr) / dpr;
  view.y = Math.round(place(view.y, view.height, frame.height) * dpr) / dpr;

  const stage = $('compare-stage');
  stage.style.width = `${view.width}px`;
  stage.style.height = `${view.height}px`;
  stage.style.transform = `translate(${view.x}px, ${view.y}px)`;

  // The divider stays on the image, even when the image is narrower than the frame.
  const left = Math.max(view.x, 0);
  const right = Math.min(view.x + view.width, frame.width);
  const position = clamp(view.split * frame.width, left, right);
  const inside = clamp(position - view.x, 0, view.width);
  $('compare-before').style.clipPath = `inset(0 ${view.width - inside}px 0 0)`;
  const handle = $('compare-handle');
  handle.style.left = `${position}px`;
  handle.setAttribute('aria-valuenow', String(Math.round((position / frame.width) * 100)));

  const zoomable = fitScale(frame, image) > 1 / dpr + 0.001 || fitScale(frame, image) < 1 / dpr - 0.001;
  $('compare-zoom').hidden = !zoomable;
  $('compare-zoom').textContent = view.zoom === 'actual' ? 'Fit to window' : 'Full size';
  $('compare-zoom').setAttribute('aria-pressed', String(view.zoom === 'actual'));
  $('compare-frame').dataset.zoom = view.zoom;
  $('compare-help').textContent = view.zoom === 'actual'
    ? 'Drag the divider to compare. Drag the image or scroll to move around it.'
    : 'Drag to compare the original on the left with the optimized image on the right.';
}

function moveSplit(clientX) {
  const frame = $('compare-frame').getBoundingClientRect();
  view.split = clamp((clientX - frame.left) / frame.width, 0, 1);
  layout();
}

function pan(dx, dy) {
  view.x += dx;
  view.y += dy;
  layout();
}

function setZoom(zoom) {
  view.zoom = zoom;
  // Keeps whatever is in the middle of the frame in the middle.
  const frame = $('compare-frame').getBoundingClientRect();
  const image = $('compare-after');
  const centerX = view.width ? (frame.width / 2 - view.x) / view.width : 0.5;
  const centerY = view.height ? (frame.height / 2 - view.y) / view.height : 0.5;
  const scale = zoom === 'actual' ? 1 / (window.devicePixelRatio || 1) : fitScale(frame, image);
  view.x = frame.width / 2 - centerX * image.naturalWidth * scale;
  view.y = frame.height / 2 - centerY * image.naturalHeight * scale;
  layout();
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  const frame = $('compare-frame');
  const onHandle = event.target === $('compare-handle');
  view.drag = onHandle || view.zoom === 'fit' ? { mode: 'split' } : { mode: 'pan', x: event.clientX, y: event.clientY };
  frame.dataset.dragging = 'true';
  frame.setPointerCapture(event.pointerId);
  if (view.drag.mode === 'split') moveSplit(event.clientX);
  event.preventDefault();
}

function onPointerMove(event) {
  if (!view.drag) return;
  if (view.drag.mode === 'split') {
    moveSplit(event.clientX);
    return;
  }
  pan(event.clientX - view.drag.x, event.clientY - view.drag.y);
  view.drag.x = event.clientX;
  view.drag.y = event.clientY;
}

function onPointerUp() {
  view.drag = null;
  $('compare-frame').dataset.dragging = 'false';
}

function onWheel(event) {
  if (view.zoom !== 'actual') return;
  event.preventDefault();
  pan(-event.deltaX, -event.deltaY);
}

function onHandleKey(event) {
  const step = event.shiftKey ? 0.1 : 0.02;
  const next = { ArrowLeft: view.split - step, ArrowRight: view.split + step, Home: 0, End: 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  view.split = clamp(next, 0, 1);
  layout();
}

function onFrameKey(event) {
  if (event.target !== $('compare-frame') || view.zoom !== 'actual') return;
  const move = { ArrowLeft: [PAN_STEP, 0], ArrowRight: [-PAN_STEP, 0], ArrowUp: [0, PAN_STEP], ArrowDown: [0, -PAN_STEP] }[event.key];
  if (!move) return;
  event.preventDefault();
  pan(...move);
}

function showStatus(message) {
  $('compare-status').textContent = message;
  $('compare-status').hidden = !message;
  const ready = !message;
  $('compare-handle').hidden = !ready;
  $('compare-stage').hidden = !ready;
  $('compare-label-before').hidden = !ready;
  $('compare-label-after').hidden = !ready;
}

function release() {
  view.token++;
  for (const url of view.urls) URL.revokeObjectURL(url);
  view.urls = [];
  $('compare-before').removeAttribute('src');
  $('compare-after').removeAttribute('src');
}

async function load(image, blob) {
  const url = URL.createObjectURL(blob);
  view.urls.push(url);
  image.src = url;
  await image.decode();
}

// before and after are promises of blobs, as the original may need decoding and the output reading back.
export async function openCompare({ title, before, after, beforeLabel, afterLabel }) {
  release();
  const token = view.token;
  Object.assign(view, { zoom: 'fit', split: 0.5, x: 0, y: 0, width: 0, height: 0 });
  $('compare-title').textContent = title;
  $('compare-label-before').textContent = beforeLabel;
  $('compare-label-after').textContent = afterLabel;
  $('compare-zoom').hidden = true;
  $('compare-help').textContent = '';
  showStatus('Loading…');
  $('compare').showModal();
  try {
    const [original, output] = await Promise.all([before, after]);
    if (token !== view.token) return;
    await Promise.all([load($('compare-before'), original), load($('compare-after'), output)]);
    if (token !== view.token) return;
    showStatus('');
    layout();
  } catch (error) {
    if (token === view.token) showStatus(`Couldn't open this image: ${error.message}`);
  }
}

export function setupCompare() {
  const frame = $('compare-frame');
  frame.addEventListener('pointerdown', onPointerDown);
  frame.addEventListener('pointermove', onPointerMove);
  frame.addEventListener('pointerup', onPointerUp);
  frame.addEventListener('pointercancel', onPointerUp);
  frame.addEventListener('wheel', onWheel, { passive: false });
  frame.addEventListener('keydown', onFrameKey);
  $('compare-handle').addEventListener('keydown', onHandleKey);
  $('compare-zoom').addEventListener('click', () => setZoom(view.zoom === 'actual' ? 'fit' : 'actual'));
  $('compare').addEventListener('close', release);
  new ResizeObserver(layout).observe(frame);
  window.addEventListener('resize', layout);
}
