---
title: "Introduction"
description: "What wasmpeg is, what it's for, and how it differs from a general-purpose FFmpeg build — a decode-focused FFmpeg/WebAssembly library for the browser and Node."
weight: 10
---
**wasmpeg is FFmpeg compiled to WebAssembly, focused on the decode → display loop.**
Load a video, get RGBA frames, scale them on the GPU, probe metadata, grab thumbnails —
from a {{% param "sizeGzMB" %}} MB gzipped WASM, with **no SharedArrayBuffer and no COOP/COEP headers**
required.

```js

await wasmpeg.load();

const dec = await wasmpeg.decode(file);   // any File / Blob / URL / Uint8Array
let frame;
while ((frame = dec.nextFrame())) {
    // frame is a Uint8ClampedArray of RGBA8 pixels (dec.width × dec.height)
    ctx.putImageData(new ImageData(frame, dec.width, dec.height), 0, 0);
}
dec.close();
```

## What it's for

wasmpeg focuses on the **decode side**: pulling frames, audio, and metadata out of media
files, plus single-frame encode for thumbnails. It runs in modern browsers and in
Node ≥ 18, loads without cross-origin isolation, and scales frames on the GPU when
WebGPU is available (falling back to CPU otherwise).

It's the right tool when you need pixels or samples in JavaScript: a frame-accurate
scrubber, a thumbnail strip, a waveform, a "what's in this file" inspector, a client-side
preview before upload. The whole library is built around getting that data across the
WASM boundary cheaply and predictably.

{{< cardgrid >}}
{{< card title="No header requirements" icon="rocket" >}}
Loads without `SharedArrayBuffer`, COOP, or COEP. No special server config, no
worker setup, no build step.
{{< /card >}}
{{< card title="Decode-first" icon="film" >}}
Frames as RGBA8, audio as interleaved float PCM, metadata without decoding, and
single-frame image encode for thumbnails.
{{< /card >}}
{{< card title="GPU when available" icon="gear" >}}
Scales on WebGPU when the browser supports it, falls back to libswscale on the CPU
transparently.
{{< /card >}}
{{< card title="Same API in Node" icon="server" >}}
Works server-side in Node ≥ 18 with the identical surface — handy for tests and
pipelines.
{{< /card >}}
{{< /cardgrid >}}

## What you get out

Every decode call resolves to one of three plain JavaScript shapes. There's no custom
frame class to learn and nothing to dispose beyond the session itself.

| Output | Type | Layout |
|--------|------|--------|
| Video frame | `Uint8ClampedArray` | RGBA8, row-major, `width × height × 4` bytes — drops straight into `ImageData` or `texImage2D` |
| Audio | `Float32Array` | Interleaved 32-bit float PCM, samples in `[-1, 1]` |
| Probe | plain object | Container name, duration, bitrate, and per-stream video/audio fields |
| Image encode | `Uint8Array` | The encoded container bytes (e.g. a JPEG or PNG) |

## What it is *not*

wasmpeg is not a general-purpose transcoder. It does **not** mux to an output
container file — there is no `ffmpeg -i in.mp4 out.webm` equivalent. The pipeline is
built to *get pixels and samples out*, run a filtergraph, and optionally encode single
frames. If you need full file-to-file transcoding, use a server-side FFmpeg.

A few specifics worth setting expectations on up front:

- **No output-file path.** `exec(['-i', 'in.mp4', 'out.webm'])` runs the decode/filter
  pipeline and returns the result in memory; it never writes `out.webm`.
- **No streaming mux or remux.** There's no path that concatenates packets into a new
  container.
- **Single-frame encode, not video encode.** `encode()` is built for thumbnails and
  stills. There's no audio/video muxing into a playable file from the high-level API.
- **H.264/H.265 encode is GPL-only.** Decode of both is in the default build; encode
  lives in `wasmpeg-full`.

{{< aside type="note" >}}
H.264/H.265 **decode** is included in the default LGPL build. H.264/H.265 **encode**
(via libx264/libx265) lives in the separate GPL `wasmpeg-full` package.
{{< /aside >}}

## How it compares to ffmpeg.wasm

If you've used `@ffmpeg/ffmpeg`, the headline difference is deployment. That project's
performant build is multi-threaded, which means `SharedArrayBuffer`, which means your
server has to send `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`
headers — and that breaks third-party embeds, some ad scripts, and a lot of static hosts.
wasmpeg is single-threaded SIMD, so none of that applies: drop it on any static host and
it runs.

The trade-off is scope. ffmpeg.wasm aims to be a full FFmpeg CLI in the browser, output
files and all. wasmpeg deliberately stops at decode, filter, probe, and single-frame
encode. If you only ever needed frames and metadata, you were carrying the cross-origin
isolation tax for features you didn't use. wasmpeg drops both.

For migration, the [`FFmpeg` compat class](/docs/start/apis/) mirrors enough of the
`@ffmpeg/ffmpeg` v0.12 surface (`load`, `writeFile`, `exec`, `on('log')`) to port simple
snippets with small edits — within the decode-focused limits above.

## Next steps

{{< cardgrid >}}
{{< linkcard title="Installation" href="/docs/start/installation/" description="npm, CDN, Node, and bundler setup." >}}
{{< linkcard title="Quick start" href="/docs/start/quick-start/" description="Decode, scale, probe, and encode in a few lines." >}}
{{< linkcard title="The three APIs" href="/docs/start/apis/" description="High-level, compat, and low-level — pick the right one." >}}
{{< linkcard title="How it works" href="/docs/start/how-it-works/" description="The layers, the pipeline, and the session model." >}}
{{< /cardgrid >}}
