// One encode per output format. Codecs load on first use, so a JPEG batch never fetches the PNG ones.
import { PNG_MIN_QUALITY, SEARCH_START } from './config.js';
import { decodeWithBrowser } from './decode.js';
import { meetsTarget, searchQuality } from './quality.js';

async function encodeLossy(image, target, format, encode) {
  const run = (img, quality) => encode(img, { quality });
  const { quality } = await searchQuality(image, run, target, SEARCH_START[format]);
  return { bytes: await run(image, quality), quality };
}

async function encodeJpeg(image, target) {
  const { default: encode } = await import('@jsquash/jpeg/encode');
  return encodeLossy(image, target, 'jpeg', encode);
}

async function encodeWebp(image, target) {
  const { default: encode } = await import('@jsquash/webp/encode');
  return encodeLossy(image, target, 'webp', encode);
}

async function quantize(image) {
  const { default: init, ImageQuantizer, encode_palette_to_png } = await import('libimagequant-wasm/wasm/libimagequant_wasm.js');
  await init();
  const quantizer = new ImageQuantizer();
  let result = null;
  try {
    quantizer.setQuality(PNG_MIN_QUALITY, 100);
    quantizer.setSpeed(4);
    result = quantizer.quantizeImage(image.data, image.width, image.height);
    result.setDithering(1);
    const indices = result.getPaletteIndices(image.data, image.width, image.height);
    const png = encode_palette_to_png(indices, result.getPalette(), image.width, image.height);
    return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
  } catch {
    return null; // Below the minimum quality, which is an expected outcome.
  } finally {
    result?.free();
    quantizer.free();
  }
}

async function encodePng(image, target) {
  const [{ default: encode }, { default: optimise }] = await Promise.all([
    import('@jsquash/png/encode'),
    import('@jsquash/oxipng/optimise'),
  ]);
  const options = { level: 2, optimiseAlpha: true };
  const quantized = await quantize(image);
  if (quantized && await meetsTarget(image, await decodeWithBrowser(quantized), target)) {
    return { bytes: await optimise(quantized, options), quality: null };
  }
  return { bytes: await optimise(await encode(image), options), quality: null };
}

const encoders = { jpeg: encodeJpeg, webp: encodeWebp, png: encodePng };

export const encode = (image, format, target) => encoders[format](image, target);
