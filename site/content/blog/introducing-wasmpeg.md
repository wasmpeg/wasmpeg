---
title: "wasmpeg 1.0: FFmpeg for the decode → display loop"
description: "wasmpeg is on npm as @wasmpeg/core and @wasmpeg/cpu — FFmpeg compiled to WebAssembly, focused on decode, not a full CLI in the browser."
date: 2026-08-30
---
wasmpeg is FFmpeg compiled to WebAssembly, and it's on npm now as
[`@wasmpeg/core`](https://www.npmjs.com/package/@wasmpeg/core) and
[`@wasmpeg/cpu`](https://www.npmjs.com/package/@wasmpeg/cpu).

```js
import wasmpeg from '@wasmpeg/core';

await wasmpeg.load();

const dec = await wasmpeg.decode(file);
let frame;
while ((frame = dec.nextFrame())) {
    // frame is a Uint8ClampedArray of RGBA8 pixels
    ctx.putImageData(new ImageData(frame, dec.width, dec.height), 0, 0);
}
dec.close();
```

## Why not just ffmpeg.wasm

Most browser FFmpeg builds aim to be the whole CLI: `-i in.mp4 -c:v libx264 out.webm`,
running in a worker. That's a lot of surface, and the performant versions of it need
`SharedArrayBuffer`, which means `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` response headers on every page that loads it. That's a
real cost — it breaks some third-party embeds and ad scripts, and plenty of static
hosts don't let you set those headers at all.

wasmpeg aims at one thing instead: the **decode → display loop**. Load a video, get
RGBA frames, scale them on the GPU, probe metadata, grab thumbnails. It's
single-threaded SIMD, so none of the cross-origin isolation tax applies — drop it on
any static host and it runs. The trade-off is scope: there's no output-file muxing, no
`-i in.mp4 out.webm`. If you need full file-to-file transcoding, that's still a
server-side job.

## What's in 1.0

- **Decode**: H.264, HEVC, VP8/9, AV1, and the rest of what FFmpeg's demuxers and
  decoders cover — see [codec coverage](/docs/formats/codecs/) for the full,
  FATE-verified list.
- **GPU scaling**: frames scale on WebGPU when it's available, falling back to
  libswscale on the CPU transparently — same call either way.
- **Probe**: container, duration, bitrate, and per-stream fields without a full decode.
- **Single-frame encode**: JPEG/PNG thumbnails from a decoded frame.
- **Three APIs**: a high-level `decode`/`probe`/`encode` surface, an `FFmpeg`-compat
  class for porting `@ffmpeg/ffmpeg` snippets, and a low-level `exec()` for filtergraphs
  — see [the three APIs](/docs/start/apis/).
- **Two packages, both LGPL**: `@wasmpeg/core` ships CPU + WebGPU; `@wasmpeg/cpu` drops
  the WebGPU binary for a smaller download where it never applies (Node, servers). A
  GPL build with H.264/H.265 *encode* exists in this repo but isn't published to npm
  yet — see [building from source](/docs/build/from-source/) if you need it now.

## Where it's tested

Every release runs against [FFmpeg's own FATE suite](/docs/formats/codecs/) — the same
sample files and reference checksums upstream FFmpeg tests itself against, not a
hand-picked subset. The current numbers are on the [codec coverage](/docs/formats/codecs/)
page, and they'll move as more of FATE gets wired up.

## Next

Release notes will land here going forward. For now:

- [Installation](/docs/start/installation/) — npm, CDN, Node, and bundler setup
- [Quick start](/docs/start/quick-start/) — decode, scale, probe, and encode in a few
  lines
- [FFmpeg → wasmpeg recipes](/docs/guides/ffmpeg-recipes/) — if you already know the
  FFmpeg CLI
