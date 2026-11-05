// Public engine API. No dependency on the site or its UI.
//
//   const batch = runBatch(items, settings, { onStart, onScore, onResult, onDone });
//   batch.cancel();
//
// items:    [{ id, file }]. Only one file per worker is in memory at a time.
// settings: { width, height, enlarge, convert: 'keep'|'webp'|'jpeg'|'png'|'smallest', quality: 'smaller'|'balanced'|'higher', fill: '#ffffff' }

// Browsers report threads, and more workers than physical cores got slower in testing (05.11.2026):
// on 6 cores and 12 threads, a batch took 27 s with 4 workers, 21 s with 6 and 25 s with 11.
export function defaultConcurrency() {
  const threads = navigator.hardwareConcurrency || 2;
  const memory = navigator.deviceMemory || 8;
  return Math.max(1, Math.min(Math.ceil(threads / 2), memory <= 4 ? 2 : 6));
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

// Makes previews one at a time on a single worker, so they never compete much with the batch.
export function createThumbnailer(size) {
  const queue = [];
  let worker = null;
  let current = null;

  function next() {
    current = queue.shift() ?? null;
    if (!current) { worker?.terminate(); worker = null; return; }
    worker ??= start();
    worker.postMessage({ preview: true, thumbSize: size, file: current.file });
  }

  function start() {
    const created = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    created.onmessage = ({ data }) => { current?.resolve(data.blob ?? null); next(); };
    created.onerror = (event) => {
      event.preventDefault();
      created.terminate();
      worker = null;
      current?.resolve(null);
      next();
    };
    return created;
  }

  return {
    add(file) {
      return new Promise((resolve) => {
        queue.push({ file, resolve });
        if (!current) next();
      });
    },
    clear() {
      for (const job of queue) job.resolve(null);
      queue.length = 0;
      current?.resolve(null);
      current = null;
      worker?.terminate();
      worker = null;
    },
  };
}

export function runBatch(items, settings, { onStart, onScore, onResult, onDone, concurrency = defaultConcurrency() }) {
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

    worker.onmessage = ({ data }) => {
      if (data.msPerMP) { onScore?.(data.msPerMP); return; }
      finishOne(current, data.result);
      if (!cancelled) next();
    };

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
