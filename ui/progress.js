// Moves the progress bars by how long the work should take, as nothing reports real progress
// during an encode. A longer estimate slows a bar down, a bar never moves backwards, and one that
// reaches the end waits there until the work finishes.

const REFERENCE_MS_PER_MP = 2000; // What the metric costs on the test laptop.
const PRIOR_WEIGHT_MS = 5000; // How much measured time it takes to outweigh the starting guess.

// Dimensions aren't known before decoding, so this goes by file size. Measuring corrects it later.
const lossyMs = (kb) => Math.min(6500, 1000 + kb * 40) + kb * 0.6;
const pngMs = (kb) => Math.min(3500, 500 + kb * 15) + kb;

export function predictMs(file, { convert }) {
  const kb = file.size / 1024;
  const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
  if (convert === 'png' || (convert === 'keep' && isPng)) return pngMs(kb);
  if (convert === 'smallest') return lossyMs(kb) + (isPng ? pngMs(kb) : lossyMs(kb));
  return lossyMs(kb);
}

// remaining is the time left, so the rate follows the latest estimate without any jump.
function advance(value, remaining, elapsed) {
  if (remaining <= 0) return 1;
  return Math.min(1, value + (1 - value) * Math.min(1, elapsed / remaining));
}

export function createPacer(items, settings, workers, now = performance.now()) {
  const predicted = new Map(items.map(({ id, file }) => [id, predictMs(file, settings)]));
  const waiting = new Set(predicted.keys());
  const running = new Map();
  let actualTotal = 0;
  let predictedTotal = 0;
  let measured = 1;
  let batch = 0;
  let last = now;

  const speed = () => (actualTotal + measured * PRIOR_WEIGHT_MS) / (predictedTotal + PRIOR_WEIGHT_MS);

  return {
    start(id, at = performance.now()) {
      waiting.delete(id);
      running.set(id, { startedAt: at, value: 0 });
    },
    finish(id, at = performance.now()) {
      const job = running.get(id);
      waiting.delete(id);
      running.delete(id);
      if (!job) return;
      actualTotal += at - job.startedAt;
      predictedTotal += predicted.get(id);
    },
    // How long the metric took on this device, known well before the first file has finished.
    scored(msPerMP) {
      measured = (measured + msPerMP / REFERENCE_MS_PER_MP) / 2;
    },
    tick(at = performance.now()) {
      const elapsed = at - last;
      last = at;
      const pace = speed();
      let queued = 0;
      for (const id of waiting) queued += predicted.get(id) * pace;
      let total = queued;
      let longest = 0;
      for (const [id, job] of running) {
        const left = Math.max(0, predicted.get(id) * pace - (at - job.startedAt));
        job.value = advance(job.value, left, elapsed);
        total += left;
        longest = Math.max(longest, left);
      }
      batch = advance(batch, Math.max(total / workers, longest), elapsed);
    },
    value: (id) => running.get(id)?.value ?? 0,
    get batch() { return batch; },
  };
}
