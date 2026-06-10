# wasmpeg

**FFmpeg for the browser, built for the decode → display loop.** Load a video, get
RGBA frames, scale them on the GPU, probe metadata, grab thumbnails — in a package
~5× smaller than `@ffmpeg/ffmpeg`, with **no SharedArrayBuffer and no COOP/COEP
headers** required.

```js
import wasmpeg from 'wasmpeg';

await wasmpeg.load();

const dec = await wasmpeg.decode(file);      // any File/Blob/URL/Uint8Array
let frame;
while ((frame = dec.nextFrame())) {
    // frame is a Uint8ClampedArray of RGBA8 pixels (dec.width × dec.height)
    ctx.putImageData(new ImageData(frame, dec.width, dec.height), 0, 0);
}
dec.close();
```

| | wasmpeg | `@ffmpeg/ffmpeg` |
|---|---------|------------------|
| WASM size | **~5 MB** | ~35 MB |
| SharedArrayBuffer | **Not required** | Required (v0.12+) |
| COOP/COEP headers | **Not required** | Required (v0.12+) |
| Cross-origin isolation | **Not required** | Required |
| WebGPU-accelerated scale | **Yes** | No |
| Frame-by-frame decode API | **Yes** | No (CLI only) |
| Full ffmpeg CLI / transcode | No | Yes |

> wasmpeg is optimized for **decode, scale, probe, and thumbnail** workloads. It is
> not a general-purpose ffmpeg CLI — if you need full transcoding pipelines, see
> [Migrating from ffmpeg.wasm](#migrating-from-ffmpegwasm) for when to use which.

---

## Install

```sh
npm install wasmpeg          # LGPL — safe for commercial / closed-source
npm install wasmpeg-full     # GPL  — adds H.264/H.265 encode (libx264/libx265)
```

No build step, no special server headers, no worker setup. Works in modern browsers
and in Node ≥ 18.

---

## Quick start

The default export is the **high-level API**. Every method accepts any input type —
`File`, `Blob`, an `http(s)` URL, a `Uint8Array`/`ArrayBuffer`, or a live
`HTMLVideoElement` / `HTMLCanvasElement` / `ImageData` — and handles buffer
management for you.

```js
import wasmpeg from 'wasmpeg';
await wasmpeg.load();
```

### Decode video frame by frame

```js
const dec = await wasmpeg.decode(file);
console.log(dec.width, dec.height, dec.fps);

let frame;
while ((frame = dec.nextFrame())) {
    // Uint8ClampedArray, length = dec.width * dec.height * 4 (RGBA8)
}
dec.close();

// Decode straight to a target size (one GPU scale, no intermediate copy):
const small = dec.nextFrame(320, 180);
```

### Scale / filter a single frame

```js
// Returns a Uint8ClampedArray of RGBA8 pixels at the target size.
const rgba = await wasmpeg.scale(file, 1280, 720);

// Any FFmpeg filtergraph works (output size is taken from the scale= in the graph):
const flipped = await wasmpeg.scale(file, 1280, 720, 'scale=1280:720,hflip');
```

### Probe metadata (no decoding)

```js
const info = await wasmpeg.probe(file);
// {
//   format: 'mov,mp4,m4a,3gp,3g2,mj2',
//   duration: 12.4,                       // seconds, or null
//   bitrate: 2_400_000,
//   streams: [{ index: 0, type: 'video' }, { index: 1, type: 'audio' }],
//   video: { width: 1920, height: 1080, fpsNum: 30000, fpsDen: 1001 },
//   audio: { sampleRate: 48000, channels: 2 },
// }
```

### Decode audio to PCM

```js
const aud = await wasmpeg.decodeAudio(file);
console.log(aud.channels, aud.sampleRate);

let chunk;
while ((chunk = aud.nextSamples())) {
    // Float32Array, interleaved samples in [-1, 1]
}
aud.close();
```

### Grab a thumbnail / encode frames

```js
// First-frame JPEG thumbnail:
const jpg = await wasmpeg.encode(file, { fmt: 'image2', codec: 'mjpeg', frames: 1 });

// Encode a canvas straight to PNG:
const png = await wasmpeg.encode(canvas, { fmt: 'image2', codec: 'png' });
```

---

## Migrating from ffmpeg.wasm

wasmpeg ships an `FFmpeg` class that mirrors the `@ffmpeg/ffmpeg` v0.12 shape, so the
load / virtual-FS / event surface you already know works the same:

```js
import { FFmpeg } from 'wasmpeg';

const ff = new FFmpeg();
ff.on('log', ({ message }) => console.log(message));
await ff.load();                 // no coreURL / workerURL / toBlobURL dance

await ff.writeFile('input.mp4', data);
const frame = await ff.exec(['-i', 'input.mp4', '-vf', 'scale=1280:720']);
```

**What carries over unchanged:** `new FFmpeg()`, `load()`, `on()`/`off()` for `'log'`
and `'progress'`, `writeFile`, `readFile`, `deleteFile`, `createDir`, `listDir`,
`terminate()`. No `SharedArrayBuffer`, no cross-origin isolation, no
`toBlobURL`/`coreURL` setup.

**What's different:** wasmpeg's `exec()` runs the **decode + filter** pipeline and
*returns* the result (RGBA pixels for a filter op, or a decoder for a decode-only
command). It does **not** transcode to an output file the way the real CLI does.
`exec([...]); readFile('out.mp4')` will not produce `out.mp4`.

| You want to… | Use |
|--------------|-----|
| Decode, scale, thumbnail, probe in the browser — small & fast | **wasmpeg** |
| Full transcode pipelines, arbitrary CLI flags, muxing to a file | stay on **ffmpeg.wasm** |

For most "show this video / extract a frame / resize" use cases, wasmpeg replaces
ffmpeg.wasm at a fraction of the size. For heavy transcoding, the two coexist fine.

---

## The three APIs

wasmpeg exposes one library at three levels of abstraction. Pick the lowest one you
need:

| Import | Level | Use when |
|--------|-------|----------|
| `import wasmpeg from 'wasmpeg'` | High | You have a `File`/`Blob`/`URL`/canvas and want frames, audio, metadata, or a thumbnail. **Start here.** |
| `import { FFmpeg } from 'wasmpeg'` | Compat | You're porting ffmpeg.wasm code and want the familiar `load`/`writeFile`/`exec` surface. |
| `import { gpu } from 'wasmpeg'` | Low | You already have raw bytes or RGBA in hand and want zero-overhead `createDecoder` / `createEncoder` / `scale` with manual lifecycle control. |

See [docs/api.md](docs/api.md) for the full reference, including the underlying C ABI.

---

## Codec support

wasmpeg tracks compatibility against FFmpeg's own FATE regression suite. The full
per-codec breakdown lives in [COMPAT.md](COMPAT.md). The main formats:

| Category | Formats |
|----------|---------|
| **Video decode** | H.264, H.265/HEVC, VP8/9, AV1, MPEG-1/2/4, H.263, VC-1, WMV1/2/3, ProRes, DNxHD, Theora, VP3/6/7, Cinepak, and more |
| **Audio decode** | AAC, Opus, MP3, Vorbis, FLAC, AC-3, E-AC-3, DTS, TrueHD, ALAC, WMA, WavPack, and more |
| **Image** | PNG, JPEG, JPEG-2000, WebP, TIFF, BMP, GIF, EXR, PSD, DPX, TGA |
| **Video encode** | MJPEG, PNG, GIF, BMP, TIFF, HuffYUV, FFV1 — plus **H.264/H.265** in `wasmpeg-full` |
| **Audio encode** | AAC, Opus, FLAC, MP2, WavPack, PCM variants |
| **Containers** | MP4, MKV, WebM, AVI, OGG, MPEG-TS, FLV, ASF, WAV, FLAC, and more |

---

## Building from source

```sh
# one-time: install the Emscripten SDK (see docs/building.md for the pinned version)
source ~/emsdk/emsdk_env.sh

PRESET=lgpl TARGET=cpu bash scripts/build.sh   # → dist/cpu.js + dist/cpu.wasm
PRESET=gpl  TARGET=cpu bash scripts/build.sh   # → dist/gpl-cpu.js + dist/gpl-cpu.wasm
```

Codec selection is data-driven: presets live in [src/cli/configure.mjs](src/cli/configure.mjs),
which generates the `./configure` flags. Full details in [docs/building.md](docs/building.md)
and [docs/configuration.md](docs/configuration.md).

---

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup,
test workflow, and the DCO sign-off requirement.

---

## License

`wasmpeg` is **LGPL-2.1-or-later** — usable in commercial and closed-source products
under the LGPL (ship the WASM as a user-replaceable, separately-linkable artifact).

`wasmpeg-full` is **GPL-2.0-or-later** because it links libx264 and libx265.
Embedding it in a closed-source product requires full GPL compliance.

FFmpeg is copyright its respective authors. H.264/H.265 patent rights are held by
MPEG-LA and Access Advance; licensing is the end user's responsibility. Not
affiliated with or endorsed by the FFmpeg project.
