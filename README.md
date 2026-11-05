# MIO

My Image Optimizer. Make a whole batch of images smaller in your browser, with no limits and no uploads.

Try it at [joosepnoorvali.com/tools/image-optimizer](https://joosepnoorvali.com/tools/image-optimizer/).

## What it does

- Takes files or whole folders of JPEG, PNG, WebP, HEIC, AVIF and BMP, and keeps the folder structure.
- Tests each image and keeps the smallest version that reaches the chosen quality, measured with [SSIMULACRA2](https://github.com/cloudinary/ssimulacra2).
- Offers three quality levels: Smaller files, Balanced and Higher quality.
- Can resize, and can convert to WebP, JPEG or PNG, or pick the smallest per image.
- Applies EXIF rotation, converts colour to sRGB and removes all metadata, including location.
- Keeps the original if the result wouldn't be smaller.
- Downloads several images as a ZIP. In Chrome and Edge it can save to a folder instead.
- Compares any result with its original using a slider, either fitted to the window or at full size.

Animated images, video, PDF and camera RAW files are skipped and listed.

## How it's organised

| Folder | Contents |
|---|---|
| `engine/` | Queue, workers and the image pipeline. It doesn't depend on the UI. |
| `ui/` | The tool's page logic and comparison view. |
| `page/` | The page markup, an Eleventy template that relies on the host site's layout and Tailwind styles. |
| `test/` | Browser tests that drive the real page with Playwright. |

## Build

```
npm install
OUT_DIR=dist npm run build
```

Without `OUT_DIR`, the build goes into the portfolio site this tool was built for. The page loads the script from `/tools/image-optimizer/app/main.js`, which is set by `base` in `vite.config.js`.

## Test

The tests need the page running on a local server, by default at `http://localhost:8080`, and images of your own in `test/samples/`, as no sample images are included. `test/quality.mjs` and `test/compare.mjs` name the files they expect at the top of the script.

```
npx playwright install chromium
node test/compare.mjs <screenshot folder>
```

## License

[GPL-3.0-or-later](LICENSE), because the tool uses libimagequant, which is GPL-3.

| Library | Used for | License |
|---|---|---|
| [jSquash](https://github.com/jamsinclair/jSquash) | JPEG, WebP and PNG encoding, oxipng, resizing | Apache-2.0 |
| [libimagequant-wasm](https://www.npmjs.com/package/libimagequant-wasm) | PNG colour reduction | MIT wrapper around [libimagequant](https://github.com/ImageOptim/libimagequant), which is GPL-3.0 |
| [calc-s2-rust](https://www.npmjs.com/package/calc-s2-rust) | SSIMULACRA2 quality score | BSD-2-Clause |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) | HEIC decoding | LGPL-3.0 |
| [client-zip](https://github.com/Touffy/client-zip) | ZIP downloads | MIT |
