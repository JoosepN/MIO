// The one place that decides how far compression goes.
// SSIMULACRA2 score the output must reach (100 = identical). Chosen by eye test on 04.11.2026:
// on photos 70 shows no visible change at full pixels and 50 changes only minor details,
// while screens with small text need 70.
export const QUALITY_LEVELS = { smaller: 50, balanced: 60, higher: 70 };
export const DEFAULT_QUALITY = 'balanced';

// Scores are measured on crops, which read a few points above the whole image.
export const CROP_MARGIN = 3;

export const TILE_SIZE = 512;
export const QUALITY_RANGE = [20, 95];
export const MAX_PROBES = 5;

// libimagequant gives up below this and the PNG stays lossless.
export const PNG_MIN_QUALITY = 70;

// Used when an image is too small to score.
export const FALLBACK_QUALITY = 85;
