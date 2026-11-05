// Public engine API. No dependency on the site or its UI.
//
//   const batch = runBatch(items, settings, { onStart, onResult, onDone });
//   batch.cancel();
//
// items:    [{ id, file }]. Only one file per worker is in memory at a time.
// settings: { width, height, enlarge, convert: 'keep'|'webp'|'jpeg'|'png'|'smallest', quality: 'smaller'|'balanced'|'higher', fill: '#ffffff' }

export function defaultConcurrency() {
  const cores = navigator.hardwareConcurrency || 2;
  const memory = navigator.deviceMemory || 8;
  return Math.max(1, Math.min(cores - 1, memory <= 4 ? 2 : 4));
}

// A blob of the original the browser can display, decoded off the main thread.
export function viewableOriginal(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data.blob);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      worker.terminate();
      reject(new Error('Ran out of memory'));
    };
    worker.postMessage({ preview: true, file });
  });
}

export function runBatch(items, settings, { onStart, onResult, onDone, concurrency = defaultConcurrency() }) {
  const queue = [...items];
  const workers = new Set();
  let remaining = items.length;
  let cancelled = false;

  const finishOne = (item, result) => {
    if (cancelled) return;
    remaining--;
    onResult?.(item, result);
    if (remaining === 0) { stop(); onDone?.({ cancelled: false }); }
  };

  function stop() {
    for (const worker of workers) worker.terminate();
    workers.clear();
  }

  function spawn() {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    workers.add(worker);
    let current = null;

    const next = () => {
      current = queue.shift();
      if (!current) { worker.terminate(); workers.delete(worker); return; }
      onStart?.(current);
      worker.postMessage({ id: current.id, file: current.file, settings });
    };

    worker.onmessage = ({ data }) => { finishOne(current, data.result); if (!cancelled) next(); };

    // A crash, usually memory on a huge image, fails that file and replaces the worker.
    worker.onerror = (event) => {
      event.preventDefault();
      worker.terminate();
      workers.delete(worker);
      const failed = current;
      if (failed) finishOne(failed, { status: 'failed', reason: 'Ran out of memory', before: failed.file.size });
      if (!cancelled && queue.length) spawn();
    };

    next();
  }

  if (!items.length) onDone?.({ cancelled: false });
  else for (let i = 0; i < Math.min(concurrency, items.length); i++) spawn();

  return {
    cancel() {
      cancelled = true;
      queue.length = 0;
      stop();
      onDone?.({ cancelled: true });
    },
  };
}
