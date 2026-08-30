# wasmpeg

![License](https://img.shields.io/badge/license-LGPL--2.1--or--later-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Status](https://img.shields.io/badge/status-pre--release-orange)

**FFmpeg for the browser, built for the decode → display loop.** Load a video, get
RGBA frames, scale them on the GPU, probe metadata, grab thumbnails, transcode to a
handful of common formats — from a 3.2 MB gzipped WASM, with **no SharedArrayBuffer
and no COOP/COEP headers** required.

```js
import wasmpeg from '@wasmpeg/core';

await wasmpeg.load();

const dec = await wasmpeg.decode(file);      // any File/Blob/URL/Uint8Array
let frame;
while ((frame = dec.nextFrame())) {
    // frame is a Uint8ClampedArray of RGBA8 pixels (dec.width × dec.height)
    ctx.putImageData(new ImageData(frame, dec.width, dec.height), 0, 0);
}
dec.close();
```

wasmpeg pulls frames, audio, and metadata out of media files, and encodes back out
to images, lossless video, and a few common audio formats. It runs in modern
browsers and in Node ≥ 18, loads without cross-origin isolation, and scales frames
on the GPU when WebGPU is available (falling back to CPU otherwise).

It's a typed decode/scale/probe/encode API, not a full CLI. Size, coverage, and
correctness trends over time — including how this compares to `@ffmpeg/core` — live
in [wasmpeg-tracking](https://github.com/wasmpeg/wasmpeg-tracking).

---

## Install

```sh
npm install @wasmpeg/core
```

`@wasmpeg/core` ships both the CPU and WebGPU binaries (LGPL). If you only need the
CPU path — server-side, or a bundle-size-sensitive browser build — `@wasmpeg/cpu` is
the same package without the WebGPU binary, roughly half the download.

No special server headers and no worker setup are required at runtime.

---

## Quick start

The default export is the **high-level API**. Every method accepts any input type —
`File`, `Blob`, an `http(s)` URL, a `Uint8Array`/`ArrayBuffer`, or a live
`HTMLVideoElement` / `HTMLCanvasElement` / `ImageData` — and handles buffer
management for you.

```js
import wasmpeg from '@wasmpeg/core';
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
//   bitrate: 2400,                        // kb/s, or -1 if unknown
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
// First-frame JPEG thumbnail (image2pipe is the default container):
const jpg = await wasmpeg.encode(file, { codec: 'mjpeg', frames: 1 });

// Encode a canvas straight to PNG:
const png = await wasmpeg.encode(canvas, { codec: 'png' });
```

### Re-encode audio

```js
const flac = await wasmpeg.encodeAudio(file, { fmt: 'flac', codec: 'flac' });
```

---

## Familiar FFmpeg class API

Alongside the high-level API, wasmpeg ships an `FFmpeg` class with a load /
virtual-filesystem / event surface:

```js
import { FFmpeg } from '@wasmpeg/core';

const ff = new FFmpeg();
ff.on('log', ({ message }) => console.log(message));
await ff.load();

await ff.writeFile('input.mp4', data);
const frame = await ff.exec(['-i', 'input.mp4', '-vf', 'scale=1280:720']);
```

It supports `new FFmpeg()`, `load()`, `on()`/`off()` for `'log'` and `'progress'`,
`writeFile`, `readFile`, `deleteFile`, `createDir`, `listDir`, and `terminate()`.

`exec()` runs the decode + filter pipeline and returns the result: RGBA pixels for a
filter op, a decoder for a decode-only command, or — when the command names an output
file — the encoded bytes, also written into the WASM FS so `readFile('out.gif')` works
after `exec(['-i', 'in.mp4', 'out.gif'])`. Supported output extensions are `gif`, `png`,
`jpg`, `bmp`, `tif`, `tga`, `dpx`, `avi`, `mkv`, `wav`, `flac`, and `ogg` — whatever this
build's encoders cover. There is no H.264/HEVC/VP8/VP9/AV1 encoder in the LGPL build, so
`.mp4`/`.webm` targets throw with a clear message rather than silently failing.

---

## The three APIs

wasmpeg exposes one library at three levels of abstraction. Pick the lowest one you
need:

| Import | Level | Use when |
|--------|-------|----------|
| `import wasmpeg from '@wasmpeg/core'` | High | You have a `File`/`Blob`/`URL`/canvas and want frames, audio, metadata, or a thumbnail. **Start here.** |
| `import { FFmpeg } from '@wasmpeg/core'` | Compat | You want the `load`/`writeFile`/`exec` surface and a virtual filesystem. |
| `import { gpu } from '@wasmpeg/core'` | Low | You already have raw bytes or RGBA in hand and want zero-overhead `createDecoder` / `createEncoder` / `scale` with manual lifecycle control. |

See [docs/reference/high-level.md](docs/reference/high-level.md) for the full reference,
or [docs/reference/c-abi.md](docs/reference/c-abi.md) for the underlying C ABI.

---

## Codec support

wasmpeg tracks compatibility against FFmpeg's own FATE regression suite. The full
per-codec breakdown lives in [COMPAT.md](COMPAT.md). The main formats:

| Category | Formats |
|----------|---------|
| **Video decode** | H.264, H.265/HEVC, VP8/9, AV1, MPEG-1/2/4, H.263, VC-1, WMV1/2/3, ProRes, DNxHD, Theora, VP3/6/7, Cinepak, and more |
| **Audio decode** | AAC, Opus, MP3, Vorbis, FLAC, AC-3, E-AC-3, DTS, TrueHD, ALAC, WMA, WavPack, and more |
| **Image** | PNG, JPEG, JPEG-2000, WebP, TIFF, BMP, GIF, EXR, PSD, DPX, TGA |
| **Video encode** | MJPEG, PNG, GIF, BMP, TIFF, HuffYUV, FFV1 — H.264/H.265 encode is GPL-only and not yet published |
| **Audio encode** | AAC, Opus, FLAC, MP2, WavPack, PCM variants |
| **Containers** | MP4, MKV, WebM, AVI, OGG, MPEG-TS, FLV, ASF, WAV, FLAC, and more |

### How we measure it

wasmpeg runs against FFmpeg's own FATE sample suite on two axes:

- **Coverage** ([COMPAT.md](COMPAT.md)) — does a file decode without erroring? Currently **86.9%** of 1242 tests.
- **Correctness** ([CORRECTNESS.md](CORRECTNESS.md)) — does the decode match FFmpeg byte-for-byte? Each frame's checksum is compared to FFmpeg's vendored reference output. Currently **93.3%** of the pure-decode video tests.

The second number is the one that matters: it's not "does it run," it's "does it produce the exact right pixels." Both are measured against the broadest build we ship and hold for every one of them — decoders and demuxers don't vary by preset. Charts of both over time, plus the size comparison against `@ffmpeg/core`, live in [wasmpeg-tracking](https://github.com/wasmpeg/wasmpeg-tracking).

---

## Building from source

```sh
# one-time: install the Emscripten SDK (see docs/build/from-source.md for the pinned version)
source ~/emsdk/emsdk_env.sh

PRESET=lgpl TARGET=cpu bash scripts/build.sh   # → dist/cpu.js + dist/cpu.wasm
PRESET=gpl  TARGET=cpu bash scripts/build.sh   # → dist/gpl-cpu.js + dist/gpl-cpu.wasm
```

Codec selection is data-driven: presets live in [src/cli/configure.mjs](src/cli/configure.mjs),
which generates the `./configure` flags. Full details in [docs/build/from-source.md](docs/build/from-source.md)
and [docs/build/configuration.md](docs/build/configuration.md).

---

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup,
test workflow, and the DCO sign-off requirement.

---

## License

`@wasmpeg/core` and `@wasmpeg/cpu` are both **LGPL-2.1-or-later** — usable in
commercial and closed-source products under the LGPL (ship the WASM as a
user-replaceable, separately-linkable artifact).

A GPL package adding H.264/H.265 encode via libx264/libx265 isn't published yet —
embedding that in a closed-source product will require full GPL compliance once it
ships.

FFmpeg is copyright its respective authors. H.264/H.265 patent rights are held by
MPEG-LA and Access Advance; licensing is the end user's responsibility. Not
affiliated with or endorsed by the FFmpeg project.
