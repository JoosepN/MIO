// Identifies files by their first bytes. Names and browser-reported types can't be trusted.
const ascii = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, start + length));

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif']);

function isAnimatedPng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const type = ascii(bytes, offset + 4, 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    offset += 12 + view.getUint32(offset);
  }
  return false;
}

export function detect(bytes) {
  if (bytes.length < 12) return { supported: false, reason: 'Not an image' };

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { supported: true, format: 'jpeg' };

  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') {
    return isAnimatedPng(bytes) ? { supported: false, reason: 'Animated image' } : { supported: true, format: 'png' };
  }

  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const animated = ascii(bytes, 12, 4) === 'VP8X' && (bytes[20] & 0x02) !== 0;
    return animated ? { supported: false, reason: 'Animated image' } : { supported: true, format: 'webp' };
  }

  if (ascii(bytes, 0, 3) === 'GIF') return { supported: false, reason: 'GIF' };
  if (ascii(bytes, 0, 2) === 'BM') return { supported: true, format: 'bmp' };
  if (ascii(bytes, 0, 4) === '%PDF') return { supported: false, reason: 'PDF' };

  if (ascii(bytes, 4, 4) === 'ftyp') {
    // The main brand alone isn't enough, as AVIF files can have mif1 there and avif further along.
    const end = Math.min(new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0), bytes.length);
    const brands = [ascii(bytes, 8, 4)];
    for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(ascii(bytes, offset, 4));
    if (brands.includes('avis')) return { supported: false, reason: 'Animated image' };
    if (brands.some((brand) => AVIF_BRANDS.has(brand))) return { supported: true, format: 'avif' };
    if (HEIC_BRANDS.has(brands[0])) return { supported: true, format: 'heic' };
    return { supported: false, reason: 'Video' };
  }

  return { supported: false, reason: 'Unsupported file' };
}
