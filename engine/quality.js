// Finds the lowest quality that still reaches the target, measured on a few crops.
// Whole-image scoring needs ~150 MB per megapixel and ~2 s per megapixel, so it can't run in a batch.
import { CROP_MARGIN, CROP_PICKS, FALLBACK_QUALITY, MAX_PROBES, QUALITY_RANGE, SEARCH_SLOPE, SEARCH_TOLERANCE, TILE_SIZE } from './config.js';
import { decodeWithBrowser } from './decode.js';

let metric = null;
let onScored = null;

// Told how long scoring takes on this device, in ms per megapixel.
export function setScoreListener(listener) {
  onScored = listener;
}

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
  const started = performance.now();
  let worst = Infinity;
  for (const backdrop of backdrops) {
    loadRgb('source', source, backdrop);
    loadRgb('candidate', candidate, backdrop);
    worst = Math.min(worst, metric.calc('source', 'candidate', source.width, source.height));
  }
  onScored?.((performance.now() - started) / backdrops.length / (source.width * source.height / 1e6));
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

function detail({ data, width }, x, y, w, h) {
  let total = 0;
  for (let row = y; row < y + h; row += 2) {
    let i = (row * width + x) * 4;
    for (let col = 0; col < w - 2; col += 2, i += 8) total += Math.abs(data[i + 1] - data[i + 9]);
  }
  return total;
}

// The busiest area plus three further down the ranking, so texture, edges and calmer areas all count.
// Only images up to a megapixel are scored whole, whatever their shape, because cost follows pixels.
function pickRegions(source, requested) {
  const { width, height } = source;
  if (width * height <= 1e6) {
    return { regions: [{ x: 0, y: 0, w: width, h: height }], target: requested };
  }
  const w = Math.min(TILE_SIZE, width);
  const h = Math.min(TILE_SIZE, height);
  const cells = [];
  for (let y = 0; y + h <= height; y += h) {
    for (let x = 0; x + w <= width; x += w) cells.push({ x, y, w, h, rank: detail(source, x, y, w, h) });
  }
  cells.sort((a, b) => b.rank - a.rank);
  const picks = CROP_PICKS.map((p) => cells[Math.floor(p * (cells.length - 1))]);
  return { regions: [...new Set(picks)], target: requested + CROP_MARGIN };
}

const tooSmallToScore = ({ width, height }) => width < 16 || height < 16;

// encode(image, quality) returns an ArrayBuffer. requested is the score the output has to reach.
// Starts near the usual answer and uses each measured score to jump close to the next try.
export async function searchQuality(source, encode, requested, start) {
  if (tooSmallToScore(source)) return { quality: FALLBACK_QUALITY, score: null };
  await loadMetric();
  const { regions, target } = pickRegions(source, requested);
  const tiles = regions.map(({ x, y, w, h }) => crop(source, x, y, w, h));
  let order = tiles.map((_, index) => index);

  // The crop that scored worst goes first next time, as one failing crop rules a quality out.
  const worstScore = async (quality) => {
    let worst = Infinity;
    let hardest = order[0];
    for (const index of order) {
      const encoded = await encode(tiles[index], quality);
      const value = score(tiles[index], await decodeWithBrowser(encoded));
      if (value < worst) { worst = value; hardest = index; }
      if (value < target) break;
    }
    order = [hardest, ...order.filter((index) => index !== hardest)];
    return worst;
  };

  let [lo, hi] = QUALITY_RANGE;
  let best = null;
  let quality = start;
  let previous = null;
  for (let probe = 0; probe < MAX_PROBES; probe++) {
    const value = await worstScore(quality);
    if (value >= target) {
      hi = quality;
      best = { quality, score: value };
      if (value - target < SEARCH_TOLERANCE) break;
    } else {
      lo = quality;
    }
    if (hi - lo <= 2) break;
    const measured = previous ? (value - previous.value) / (quality - previous.quality) : 0;
    const slope = measured > 0.1 && measured < 3 ? measured : SEARCH_SLOPE;
    previous = { quality, value };
    // Staying away from the known limits narrows the range on every try, however far off the slope is.
    // Without this, one bad jump can use up the tries and leave a far too high quality.
    const inset = Math.max(1, Math.ceil((hi - lo) / 5));
    quality = Math.max(lo + inset, Math.min(hi - inset, Math.round(quality + (target + SEARCH_TOLERANCE / 2 - value) / slope)));
  }
  return best ?? { quality: hi, score: null };
}

// For outputs with no quality dial, like a quantized PNG: does this version clear the target?
export async function meetsTarget(source, candidate, requested) {
  if (tooSmallToScore(source)) return true;
  await loadMetric();
  const { regions, target } = pickRegions(source, requested);
  return regions.every(({ x, y, w, h }) => score(crop(source, x, y, w, h), crop(candidate, x, y, w, h)) >= target);
}
