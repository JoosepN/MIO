// The one place that decides how far compression goes.
// SSIMULACRA2 score the output must reach (100 = identical). Chosen by eye test on 04.11.2026:
// on photos 70 shows no visible change at full pixels and 50 changes only minor details,
// while screens with small text need 70.
export const QUALITY_LEVELS = { smaller: 50, balanced: 60, higher: 70 };
export const DEFAULT_QUALITY = 'balanced';

// Scores are measured on crops, which read a few points above the whole image.
export const CROP_MARGIN = 3;

export const TILE_SIZE = 512;
// Which crops get scored, as positions in the image's areas ranked from busiest to calmest.
// Adding a calmer crop at 0.95 made files up to 47% larger in testing (05.11.2026), so it's left out.
export const CROP_PICKS = [0, 0.25, 0.5, 0.75];
export const QUALITY_RANGE = [20, 95];
export const MAX_PROBES = 5;

// Where the search starts, near the usual answer, and how far above the target it may stop.
export const SEARCH_START = { jpeg: 62, webp: 68 };
export const SEARCH_TOLERANCE = 1;
// Score points gained per quality step, until two tries have measured it.
export const SEARCH_SLOPE = 0.6;

// libimagequant gives up below this and the PNG stays lossless.
export const PNG_MIN_QUALITY = 70;

// Used when an image is too small to score.
export const FALLBACK_QUALITY = 85;
