// Pixels out, in sRGB, with EXIF rotation applied. The browser decoder does both for everything
// it can read. HEIC goes through libheif, which applies its own rotation but not colour.

export async function decodeWithBrowser(data) {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// iPhones tag photos with a Display P3 profile, either as an ICC name or an nclx colour box.
function isDisplayP3(bytes) {
  const name = 'Display P3';
  const nclxPrimaries = 12;
  const limit = Math.min(bytes.length, 256 * 1024);
  for (let i = 0; i < limit - 24; i++) {
    if (bytes[i] === 0x6e && bytes[i + 1] === 0x63 && bytes[i + 2] === 0x6c && bytes[i + 3] === 0x78) {
      return ((bytes[i + 4] << 8) | bytes[i + 5]) === nclxPrimaries;
    }
    if (bytes[i] === 0x00 && bytes[i + 1] === 0x44) {
      let match = true;
      for (let c = 0; c < name.length && match; c++) {
        match = bytes[i + c * 2] === 0 && bytes[i + c * 2 + 1] === name.charCodeAt(c);
      }
      if (match) return true;
    }
  }
  return false;
}

const toLinear = new Float32Array(256).map((_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});
const toGamma = (v) => {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055); // The clamped array rounds it.
};

function displayP3ToSrgb(data) {
  for (let i = 0; i < data.length; i += 4) {
    const r = toLinear[data[i]];
    const g = toLinear[data[i + 1]];
    const b = toLinear[data[i + 2]];
    data[i] = toGamma(1.2249 * r - 0.2247 * g);
    data[i + 1] = toGamma(-0.042 * r + 1.0419 * g);
    data[i + 2] = toGamma(-0.0197 * r - 0.0786 * g + 1.0979 * b);
  }
}

async function decodeHeic(bytes) {
  const { default: factory } = await import('libheif-js/libheif-wasm/libheif-bundle.mjs');
  const lib = await factory();
  const [image] = new lib.HeifDecoder().decode(bytes);
  if (!image) throw new Error('This HEIC file could not be read');
  const width = image.get_width();
  const height = image.get_height();
  const data = new Uint8ClampedArray(width * height * 4);
  await new Promise((resolve, reject) => {
    image.display({ data, width, height }, (out) => (out ? resolve() : reject(new Error('This HEIC file could not be read'))));
  });
  image.free();
  if (isDisplayP3(bytes)) displayP3ToSrgb(data);
  return new ImageData(data, width, height);
}

export const decode = (bytes, format) => (format === 'heic' ? decodeHeic(bytes) : decodeWithBrowser(bytes));
