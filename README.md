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

## Run it

```
npm install
npm run dev
```

## Deploy it

```
npm run build
```

Upload the `dist` folder to any static host. It needs no server, and it runs from any path.

## Put it inside your own page

```
npm run build:embed
```

This puts `main.js`, `tool.css` and the codecs in `dist`, without a page. Then, on your page:

1. Add the contents of `ui/tool.html` where the tool should appear.
2. Link `tool.css`, and load `main.js` with `<script type="module">`.
3. To match your colours, set the `--mio-*` variables from the top of `ui/tool.css` on `html .mio`.

## How it's organised

| Path | Contents |
|---|---|
| `engine/` | Queue, workers and the image pipeline. It doesn't depend on the UI. |
| `ui/` | The tool's markup, styles, page logic and comparison view. |
| `index.html` | The standalone page around the tool. |
| `test/` | Browser tests that drive the real page with Playwright. |

## Test

The tests need the tool running, and images of your own in `test/samples/`, as no sample images are included. `test/quality.mjs`, `test/compare.mjs` and `test/visual.mjs` name the files they expect at the top of the script.

```
npx playwright install chromium firefox
npm run build
npm run preview -- --port 8080
MIO_PATH=/ node test/compare.mjs <screenshot folder>
```

## License

[GPL-3.0-or-later](LICENSE), because the tool uses libimagequant, which is GPL-3. If you publish a modified version, the GPL requires you to share its source too, so update the links at the bottom of `ui/tool.html` to point to your fork.

| Library | Used for | License |
|---|---|---|
| [jSquash](https://github.com/jamsinclair/jSquash) | JPEG, WebP and PNG encoding, oxipng, resizing | Apache-2.0 |
| [libimagequant-wasm](https://www.npmjs.com/package/libimagequant-wasm) | PNG colour reduction | MIT wrapper around [libimagequant](https://github.com/ImageOptim/libimagequant), which is GPL-3.0 |
| [calc-s2-rust](https://www.npmjs.com/package/calc-s2-rust) | SSIMULACRA2 quality score | BSD-2-Clause |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) | HEIC decoding | LGPL-3.0 |
| [client-zip](https://github.com/Touffy/client-zip) | ZIP downloads | MIT |
