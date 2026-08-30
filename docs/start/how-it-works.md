---
title: "How it works"
description: "The architecture of wasmpeg — the JS layers, the WASM module, and the FFmpeg pipeline underneath — plus the session model and memory rules that make the API predictable."
weight: 50
---
wasmpeg is a thin, decode-focused wrapper over FFmpeg compiled to WebAssembly. Understanding
the three layers it's built from makes the whole API predictable.

## The layers

```
your code
   │
   ├─ wasmpeg            high-level: any input, buffers managed for you
   ├─ FFmpeg             @ffmpeg/ffmpeg-style class + virtual filesystem
   └─ gpu                low-level typed pipeline (bytes / RGBA in, manual lifecycle)
        │
        └─ exec.mjs      FFmpeg-style arg dispatcher
             │
             └─ pipeline.c (WASM)   EMSCRIPTEN_KEEPALIVE C ABI
                  │
                  └─ libav* + libswscale (+ optional WebGPU scale)
```

Every level resolves to the same exported C functions in `pipeline.c`. The higher you go,
the more is done for you (input normalization, buffer copies, format inference); the lower
you go, the more control and the less overhead.

- **[wasmpeg](/docs/reference/high-level/)** — the default export. Pass a `File`, `Blob`, URL,
  `Uint8Array`, or canvas; it handles the rest.
- **[FFmpeg](/docs/reference/ffmpeg-class/)** — a familiar `load`/`writeFile`/`exec` surface with
  a virtual filesystem, for porting ffmpeg.wasm code.
- **[gpu](/docs/reference/gpu/)** — the typed pipeline; you pass raw bytes/RGBA and manage
  decoder and encoder lifecycles yourself.

All three share one WASM module instance per environment. Calling `load()` on any of them
instantiates it once; later calls are no-ops that resolve immediately. There's no separate
module per decoder or per call.

## Input normalization

The high-level API and the dispatcher accept any of these and reduce them to one of three
internal shapes before touching WASM:

| You pass | Becomes | Notes |
|----------|---------|-------|
| `Uint8Array`, `ArrayBuffer` | encoded bytes | Passed straight through |
| `File`, `Blob` | encoded bytes | Read via `arrayBuffer()`; `File.name` is kept as a format hint |
| `http(s)` URL string | encoded bytes | Fetched; the URL pathname is kept as a hint |
| Leading-`/` string | WASM FS path | Used with the file-path decoder; not supported by `probe`/`decodeAudio` yet |
| `HTMLVideoElement` | raw RGBA | Drawn to a canvas, one frame grabbed (browser only) |
| `HTMLCanvasElement`, `ImageData` | raw RGBA | Pixels read directly (browser only) |

The `name` derived from a file or URL feeds **format inference**: a small table maps
extensions (and a couple of path fragments) to FFmpeg demuxer names for formats that don't
identify themselves by content alone — mostly legacy and game audio. Content-probeable
formats like MP4 or WebM need no hint. You can always force a demuxer by passing
`{ format }` to `decode()` / `decodeAudio()`.

## The decode pipeline

A decode call walks a fixed path through FFmpeg's libraries:

1. **Demux** — `libavformat` opens the container and identifies streams.
2. **Decode** — `libavcodec` turns packets into raw frames in the codec's native pixel
   format (often YUV).
3. **Convert / scale** — `libswscale` (CPU) or the `scale_webgpu` filter (GPU) converts to
   **RGBA8** and resizes if you asked for a target size.
4. **Hand off** — the RGBA bytes are copied across the WASM boundary into a
   `Uint8ClampedArray` you can drop into `putImageData` or a texture.

Audio follows the same shape, ending in interleaved 32-bit float PCM instead of pixels.

### Frames are pulled, not pushed

Decoders are iterators. `nextFrame()` advances the demux/decode loop until one converted
frame is ready, copies it out, and returns it; it returns `null` at end of stream. Nothing
decodes ahead of you, so memory stays flat across a long file — you only ever hold the frame
you asked for. Audio works the same way through `nextSamples()`, which returns a
variable-length chunk (one decoded frame's worth of samples) or `null` at EOF.

### Decoding straight to a target size

`nextFrame(dstW, dstH)` resizes during the convert step instead of after. That's one scale
pass and no intermediate full-resolution copy in JS — the cheapest way to get, say, 1080p
source down to a 320×180 thumbnail. The decoder grows its internal output buffer if you ask
for a size larger than the last one.

## Why RGBA8

Browsers speak RGBA. `ImageData`, `texImage2D`, and `<canvas>` all expect 8-bit RGBA, so
wasmpeg converts to it at the edge. That conversion is the one unavoidable cost of "video in
the browser," and it's exactly what `libswscale`/`scale_webgpu` are optimized for.

Picking RGBA8 at the boundary also keeps the JS surface tiny: there's a single frame layout
to document, no plane strides or chroma subsampling to reason about, and the output is
already in the format every browser sink wants.

## CPU and GPU builds

There are two WASM builds from the same source:

- **CPU build** (`cpu.wasm`) — SIMD128-accelerated `libswscale`. The tested, default path.
- **WebGPU build** (`webgpu.wasm`) — adds a `scale_webgpu` filter that runs the resize on
  the GPU. Experimental; see [WebGPU](/docs/webgpu/).

The loader picks a build at `load()` time based on the environment: if `navigator.gpu`
exists it fetches the WebGPU build, otherwise the CPU build. Node has no WebGPU adapter, so
it always gets the CPU build, and it reads the `.wasm` from disk rather than fetching it. The
public API is identical either way — `scale()` emits a `scale_webgpu` filter on the GPU build
and a plain `scale` filter on the CPU build, and falls back silently if WebGPU isn't usable.

## Sessions and memory

Decoders, audio decoders, and probes share a pool of **8 session slots** inside the WASM
module; encoders have their own pool of 4. Opening one takes a slot; `close()` frees it.
This is the single most important runtime detail:

{{< aside type="caution" >}}
Always `close()` a decoder/encoder when you're done. The high-level API does this for
one-shot calls, but long-lived loops that open decoders must close each one — otherwise you
exhaust the pool and the next open throws [`ENOMEM`](/docs/reference/errors/).
{{< /aside >}}

### Who closes for you

| Call | Lifecycle |
|------|-----------|
| `probe()` | Opens and closes its slot internally — nothing to clean up |
| `scale()` | One-shot; opens a decoder, takes a frame, closes it for you |
| `encode()` | Manages its own decoder and encoder slots end to end |
| `decode()` / `decodeAudio()` | **You own it.** Hold the slot until you call `close()` |

The pattern that gets people is opening a fresh decoder per frame in a render loop and never
closing the old one. Eight opens later, the next call throws. Open once, iterate, close once.

### Buffers cross the boundary by copy

Frames and samples are read out of the WASM heap with `.slice()`, so the array you get back
owns its own memory and survives the next decode call. The decoder reuses one internal heap
buffer between frames; the copy is what makes that safe. The cost is one memcpy per frame,
which is small next to the decode and color conversion.

## What it deliberately doesn't do

There is no output-container/transcode path — wasmpeg gets pixels, samples, and metadata
*out*, and encodes single frames for thumbnails. There's no `-i in.mp4 out.webm`. If you
need full file-to-file transcoding, run FFmpeg server-side. See the
[command reference](/docs/reference/exec-commands/) for exactly what the dispatcher supports.

The `exec` dispatcher parses a broad set of FFmpeg flags (input/output options, codecs,
filters, stream specifiers) so familiar command strings don't error on an unknown token, but
it only *acts* on the decode/filter subset. An output filename is parsed and then ignored —
the result comes back in memory, not on disk.

## Next

- [Installation](/docs/start/installation/) — get it into your project.
- [The three APIs](/docs/start/apis/) — pick the right level.
- [Quick start](/docs/start/quick-start/) — decode, scale, probe, encode in a few lines.
