// Finds the lowest quality that still reaches the target, measured on a few crops.
// Whole-image scoring needs ~150 MB per megapixel and ~2 s per megapixel, so it can't run in a batch.
import { CROP_MARGIN, FALLBACK_QUALITY, MAX_PROBES, QUALITY_RANGE, TILE_SIZE } from './config.js';
import { decodeWithBrowser } from './decode.js';

let metric = null;

async function loadMetric() {
  if (metric) return metric;
  const module = await import('calc-s2-rust');
  // The package logs every buffer it allocates. Keep the console readable.
  const log = console.log;
  console.log = (...args) => { if (!String(args[0]).startsWith('[C]')) log(...args); };
  const wasm = await module.default();
  metric = { wasm, calc: module.calc_s2, buffer: module.new_buffer };
  return metric;
}

export function hasAlpha({ data }) {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  return false;
}

// The metric reads RGB only, so transparency is flattened onto a backdrop first.
function loadRgb(key, { data, width, height }, backdrop) {
  const length = width * height * 3;
  const pointer = metric.buffer(key, length);
  const out = new Uint8Array(metric.wasm.memory.buffer, pointer, length);
  for (let i = 0, o = 0; i < data.length; i += 4, o += 3) {
    const a = data[i + 3];
    out[o] = (data[i] * a + backdrop * (255 - a)) / 255;
    out[o + 1] = (data[i + 1] * a + backdrop * (255 - a)) / 255;
    out[o + 2] = (data[i + 2] * a + backdrop * (255 - a)) / 255;
  }
}

// Transparent images have to hold up on light and dark pages, so the worse backdrop counts.
function score(source, candidate) {
  const backdrops = hasAlpha(source) || hasAlpha(candidate) ? [255, 0] : [255];
  let worst = Infinity;
  for (const backdrop of backdrops) {
    loadRgb('source', source, backdrop);
    loadRgb('candidate', candidate, backdrop);
    worst = Math.min(worst, metric.calc('source', 'candidate', source.width, source.height));
  }
  return worst;
}

function crop({ data, width }, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const start = ((y + row) * width + x) * 4;
    out.set(data.subarray(start, start + w * 4), row * w * 4);
  }
  return new ImageData(out, w, h);
}

function detail({ data, width }, x, y, size) {
  let total = 0;
  for (let row = y; row < y + size; row += 2) {
    let i = (row * width + x) * 4;
    for (let col = 0; col < size - 2; col += 2, i += 8) total += Math.abs(data[i + 1] - data[i + 9]);
  }
  return total;
}

// The busiest area plus three further down the ranking, so texture, edges and calmer areas all count.
// Small images are scored whole.
function pickRegions(source, requested) {
  const { width, height } = source;
  const size = TILE_SIZE;
  if (width < size * 2 || height < size * 2 || width * height <= 1e6) {
    return { regions: [{ x: 0, y: 0, w: width, h: height }], target: requested };
  }
  const cells = [];
  for (let y = 0; y + size <= height; y += size) {
    for (let x = 0; x + size <= width; x += size) cells.push({ x, y, w: size, h: size, rank: detail(source, x, y, size) });
  }
  cells.sort((a, b) => b.rank - a.rank);
  const picks = [0, 0.25, 0.5, 0.75].map((p) => cells[Math.floor(p * (cells.length - 1))]);
  return { regions: [...new Set(picks)], target: requested + CROP_MARGIN };
}

const tooSmallToScore = ({ width, height }) => width < 16 || height < 16;

// encode(image, quality) returns an ArrayBuffer. requested is the score the output has to reach.
export async function searchQuality(source, encode, requested) {
  if (tooSmallToScore(source)) return { quality: FALLBACK_QUALITY, score: null };
  await loadMetric();
  const { regions, target } = pickRegions(source, requested);
  const tiles = regions.map(({ x, y, w, h }) => crop(source, x, y, w, h));

  const passes = async (quality) => {
    let worst = Infinity;
    for (const tile of tiles) {
      const encoded = await encode(tile, quality);
      worst = Math.min(worst, score(tile, await decodeWithBrowser(encoded)));
      if (worst < target) return { pass: false, value: worst }; // One failing crop rules it out.
    }
    return { pass: true, value: worst };
  };

  let [lo, hi] = QUALITY_RANGE;
  let best = null;
  for (let probe = 0; probe < MAX_PROBES && hi - lo > 3; probe++) {
    const quality = Math.round((lo + hi) / 2);
    const { pass, value } = await passes(quality);
    if (pass) { hi = quality; best = { quality, score: value }; } else lo = quality;
  }
  return best ?? { quality: QUALITY_RANGE[1], score: null };
}

// For outputs with no quality dial, like a quantized PNG: does this version clear the target?
export async function meetsTarget(source, candidate, requested) {
  if (tooSmallToScore(source)) return true;
  await loadMetric();
  const { regions, target } = pickRegions(source, requested);
  return regions.every(({ x, y, w, h }) => score(crop(source, x, y, w, h), crop(candidate, x, y, w, h)) >= target);
}
