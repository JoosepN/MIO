// The fixed per-file order: read, orient, resize, colour, strip metadata, encode.
// Orientation and colour happen during decoding. Metadata goes because encoders write none.
import { DEFAULT_QUALITY, QUALITY_LEVELS } from './config.js';
import { decode } from './decode.js';
import { detect } from './detect.js';
import { encode } from './encode.js';
import { hasAlpha } from './quality.js';

const NATURAL_OUTPUT = { jpeg: 'jpeg', png: 'png', webp: 'webp', heic: 'jpeg', avif: 'webp', bmp: 'png' };
const EXTENSION = { jpeg: 'jpg', png: 'png', webp: 'webp' };

// Fits inside the given box, keeps proportions, and never changes the shape.
export function targetSize(width, height, { width: maxWidth, height: maxHeight, enlarge }) {
  if (!maxWidth && !maxHeight) return { width, height };
  let scale = Math.min(maxWidth ? maxWidth / width : Infinity, maxHeight ? maxHeight / height : Infinity);
  if (!enlarge) scale = Math.min(1, scale);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function resized(image, settings) {
  const size = targetSize(image.width, image.height, settings);
  if (size.width === image.width && size.height === image.height) return image;
  const { default: resize } = await import('@jsquash/resize');
  return resize(image, { ...size, method: 'lanczos3' });
}

function candidatesFor(sourceFormat, convert) {
  const natural = NATURAL_OUTPUT[sourceFormat];
  if (convert === 'smallest') return [...new Set([natural, 'webp'])];
  return [convert === 'keep' ? natural : convert];
}

function fillBackground(image, color) {
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const data = new Uint8ClampedArray(image.data);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    data[i] = (data[i] * a + r * (255 - a)) / 255;
    data[i + 1] = (data[i + 1] * a + g * (255 - a)) / 255;
    data[i + 2] = (data[i + 2] * a + b * (255 - a)) / 255;
    data[i + 3] = 255;
  }
  return new ImageData(data, image.width, image.height);
}

// A version of the original the browser can show. Only HEIC needs converting.
export async function viewable(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { format } = detect(bytes);
  if (format !== 'heic') return file;
  const image = await decode(bytes, format);
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext('2d').putImageData(image, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

export async function optimize(file, settings) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = detect(bytes);
  if (!info.supported) return { status: 'skipped', reason: info.reason, before: file.size };

  const decoded = await decode(bytes, info.format);
  const image = await resized(decoded, settings);
  const sizeChanged = image.width !== decoded.width || image.height !== decoded.height;
  const transparent = hasAlpha(image);

  const target = QUALITY_LEVELS[settings.quality] ?? QUALITY_LEVELS[DEFAULT_QUALITY];
  let best = null;
  let filled = false;
  for (const format of candidatesFor(info.format, settings.convert)) {
    let input = image;
    if (format === 'jpeg' && transparent) {
      input = fillBackground(image, settings.fill);
      filled = true;
    }
    const { bytes: encoded, quality } = await encode(input, format, target);
    if (!best || encoded.byteLength < best.encoded.byteLength) best = { encoded, format, quality };
  }

  // Never make a file worse. A requested resize still has to be honoured, though.
  if (!sizeChanged && best.encoded.byteLength >= file.size) {
    return {
      status: 'done', kept: true, before: file.size, after: file.size,
      format: info.format, extension: null, width: decoded.width, height: decoded.height,
    };
  }

  return {
    status: 'done', kept: false, before: file.size, after: best.encoded.byteLength,
    source: info.format, format: best.format, extension: EXTENSION[best.format], quality: best.quality,
    width: image.width, height: image.height, filled: filled && best.format === 'jpeg',
    sameFormat: best.format === NATURAL_OUTPUT[info.format] && best.format === info.format,
    blob: new Blob([best.encoded], { type: `image/${best.format}` }),
  };
}
