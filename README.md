# wasmpeg

FFmpeg in the browser with WebGPU-accelerated video processing. Ships in two packages:

| Package | License | H.264/H.265 encode | Use when |
|---------|---------|-------------------|----------|
| `wasmpeg` | LGPL-2.1-or-later | No | Commercial products, libraries |
| `wasmpeg-full` | GPL-2.0-or-later | Yes (libx264/libx265) | Open-source projects, internal tools |

Both packages are ~10x smaller than `@ffmpeg/ffmpeg`, require no SharedArrayBuffer, and include the WebGPU-accelerated scale pipeline.

## Install

```sh
# LGPL — safe for commercial use
npm install wasmpeg

# GPL — H.264/H.265 encode, open-source projects only
npm install wasmpeg-full
```

## Usage

```js
import wasmpeg from 'wasmpeg';

await wasmpeg.load();

// Scale a video frame
const frame = await wasmpeg.scale(file, 1280, 720);

// Decode video frame by frame
const dec = await wasmpeg.decode(file);
while (true) {
    const frame = dec.nextFrame();
    if (!frame) break;
    // frame is Uint8ClampedArray RGBA
}
dec.close();

// Decode audio
const aud = await wasmpeg.decodeAudio(file);
while (true) {
    const chunk = aud.nextSamples(); // Float32Array interleaved
    if (!chunk) break;
}
aud.close();

// Probe metadata without decoding
const info = await wasmpeg.probe(file);
console.log(info.format, info.duration, info.video.width, info.video.height);

// Encode frames to JPEG/PNG/WebM
const jpg = await wasmpeg.encode(file, { fmt: 'image2', codec: 'mjpeg' });

// Run ffmpeg-style commands
const result = await wasmpeg.run(file, '-vf scale=1280:720');
```

### FFmpeg compat API

Drop-in replacement for `@ffmpeg/ffmpeg`:

```js
import { FFmpeg } from 'wasmpeg';

const ff = new FFmpeg();
await ff.load();
await ff.writeFile('input.mp4', data);
await ff.exec(['-i', 'input.mp4', '-vf', 'scale=1280:720', 'output.mp4']);
const out = await ff.readFile('output.mp4');
```

## Codec support

### LGPL build (`wasmpeg`)

| Category | Codecs |
|----------|--------|
| Video decode | H.264, H.265/HEVC, VP8, VP9, AV1, MPEG-1/2/4, H.263, VC-1, WMV1/2/3, ProRes, DNxHD, Theora, VP3/6/7, and more |
| Audio decode | AAC, Opus, MP3, Vorbis, FLAC, AC3, EAC3, DTS, TrueHD, ALAC, WMA, WavPack, and more |
| Video encode | MJPEG, PNG, GIF, BMP, TIFF, HuffYUV, FFV1 |
| Audio encode | AAC, Opus, FLAC, MP2, PCM variants |
| Containers | MP4, MKV, WebM, AVI, OGG, MPEG-TS, FLV, ASF, WAV, FLAC, and more |

### GPL build (`wasmpeg-full`)

Everything above, plus:

| Category | Codecs |
|----------|--------|
| Video encode | **H.264 (libx264)**, **H.265 (libx265)** |

## Why not `@ffmpeg/ffmpeg`?

| | wasmpeg | @ffmpeg/ffmpeg |
|--|---------|---------------|
| WASM size | ~8MB | ~35MB |
| SharedArrayBuffer required | No | Yes (v0.12+) |
| COEP/COOP headers required | No | Yes (v0.12+) |
| WebGPU scale | Yes | No |
| Full ffmpeg CLI | No | Yes |
| H.264 encode | GPL build only | Yes |

wasmpeg is optimized for the decode-display pipeline: load a video, get frames, process them. It is not a general-purpose ffmpeg CLI replacement.

## Building from source

```sh
# LGPL build (wasmpeg)
PRESET=lgpl TARGET=cpu bash scripts/build.sh

# GPL build (wasmpeg-full)
PRESET=gpl TARGET=cpu bash scripts/build.sh

# WebGPU builds
PRESET=lgpl TARGET=webgpu bash scripts/build.sh
PRESET=gpl  TARGET=webgpu bash scripts/build.sh
```

See [docs/building.md](docs/building.md) for prerequisites and the GPL external library setup.

## License

`wasmpeg` is LGPL-2.1-or-later. You may use it in commercial and closed-source products provided you comply with the LGPL (dynamic linking or user-replaceable WASM).

`wasmpeg-full` is GPL-2.0-or-later due to libx264 and libx265. Embedding it in a closed-source product requires GPL compliance.

FFmpeg is copyright its respective authors. Patent rights for H.264 and H.265 are held by MPEG-LA and HEVC Advance — licensing is the responsibility of the end user.

Not affiliated with or endorsed by the FFmpeg project.
