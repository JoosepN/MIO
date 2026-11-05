import { optimize, thumbnail, viewable } from './pipeline.js';

self.onmessage = async ({ data: { id, file, settings, preview, thumbSize } }) => {
  if (preview) {
    try {
      postMessage({ blob: await (thumbSize ? thumbnail(file, thumbSize) : viewable(file)) });
    } catch (error) {
      postMessage({ error: String(error?.message ?? error) });
    }
    return;
  }
  try {
    postMessage({ id, result: await optimize(file, settings) });
  } catch (error) {
    postMessage({ id, result: { status: 'failed', reason: String(error?.message ?? error), before: file.size } });
  }
};
