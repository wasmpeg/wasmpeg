---
title: "Troubleshooting & FAQ"
description: "Fixes for the common wasmpeg issues — the WASM failing to load, ENOMEM, formats that won't open, blank frames, and the questions people ask most."
weight: 90
---
Most problems fall into a handful of buckets. Find the symptom below, or scan the
[FAQ](#faq) for the conceptual questions.

## Loading and setup

### The WASM fails to load

**Symptom:** a 404 for `cpu.wasm` in the network tab, or `load()` rejects.

The `.js` loads its `.wasm` from the same directory. If your bundler doesn't co-locate them,
copy the binaries into your static directory and pass an explicit path:

```sh
cp node_modules/wasmpeg/dist/cpu.* public/wasmpeg/
```

```js
await wasmpeg.load({ wasmPath: '/wasmpeg/cpu.js' });   // cpu.wasm sits beside it
```

See the [framework guides](/docs/guides/frameworks/vite/) for per-tool specifics.

In Node, `load()` reads the `.wasm` off disk next to the `.js` and passes it in directly, so
the same co-location rule applies — keep the pair together if you copy them out of
`node_modules`.

### load() throws immediately

**Symptom:** `load()` rejects before any decode, often mentioning SIMD or instantiation.

The browser likely lacks **SIMD128**. wasmpeg requires Chrome 91+, Firefox 89+, or Safari
16.4+. Check the [support matrix](/docs/start/support/). There's no non-SIMD fallback in the
default build.

### "call wasmpeg.load() first"

You used a method before `load()` resolved. Always `await wasmpeg.load()` once before any
`decode`/`scale`/`probe`/`encode`/`run`. It's safe to call repeatedly — later calls resolve
instantly — so a top-level `await wasmpeg.load()` at startup is fine.

Note the three entry points each have their own latch: `wasmpeg` (high-level), `gpu`
(low-level), and the `FFmpeg` class. Calling `wasmpeg.load()` doesn't satisfy `gpu`'s check,
and vice versa. Load whichever surface you actually call. They share one underlying module, so
loading more than one is cheap.

### Wrong build loaded (CPU vs WebGPU)

wasmpeg picks the WebGPU build when `navigator.gpu` exists and the CPU build otherwise. If you
want to pin one — for reproducible behavior, or because a WebGPU driver is flaky — pass an
explicit `wasmPath`:

```js
await wasmpeg.load({ wasmPath: '/wasmpeg/cpu.js' });
```

The choice only affects whether `scale` can offload to the GPU; decode, audio, probe, and
encode are identical on both. See [WebGPU](/docs/webgpu/).

## Memory and sessions

### ENOMEM (-12) after a few operations

**Symptom:** the first few decodes work, then opening a new one throws `-12`.

You're leaking [session slots](/docs/start/how-it-works/#sessions-and-memory). There are only 8
shared decoder/audio/probe slots. Every `decode`/`decodeAudio`/`gpu.createDecoder` must be
paired with `close()`:

```js
const dec = await wasmpeg.decode(file);
try {
    let frame;
    while ((frame = dec.nextFrame())) { /* … */ }
} finally {
    dec.close();   // always, even on error
}
```

The same applies to `decodeAudio` and `gpu.probe`/`gpu.createDecoder`. The high-level
`probe()` and `encode()` open and close their sessions internally, so those don't count
against you — only the iterator-style calls that hand you a `close()` do. If you fan out many
decodes (a thumbnail grid, a batch), process them sequentially or cap concurrency at a few so
you never need more than 8 live at once.

{{< aside type="caution" >}}
A thrown error mid-loop leaks the slot unless `close()` runs. Always close in a `finally`, not
just after a clean exit.
{{< /aside >}}

### Out of memory on a large file

**Symptom:** an allocation failure decoding a long or high-resolution clip even though slots
aren't leaking.

Holding every frame at once is the usual cause — a few minutes of 1080p RGBA is gigabytes.
Process each frame and let it go, or decode straight to a smaller size with
`nextFrame(w, h)` so the resampled frame is all that's resident. There's no streaming-to-disk
fallback; the working set has to fit in WASM memory.

## Decoding problems

### A file won't open / DECODER or DEMUXER not found

- If the **container doesn't content-probe** (raw bitstreams, many game/legacy formats),
  force the demuxer: `await wasmpeg.decode(bytes, { format: 'dnxhd' })`. Note this only
  works through the high-level `decode()`/`decodeAudio()`, not `run()`/`exec()`.
- If the **codec isn't in your build**, you'll get
  [`AVERROR_DECODER_NOT_FOUND`](/docs/reference/errors/). The default build is broad; check the
  [codec list](/docs/formats/codecs/) and, for custom builds, add it to a preset and rebuild.

### Format guessed wrong from the filename

**Symptom:** a file with a misleading or generic name decodes oddly or not at all.

For the handful of formats that can't be content-probed, wasmpeg infers the demuxer from the
source filename — a `File.name`, a URL path, an FS path. If the name is absent or wrong, the
guess can miss. Pass `{ format }` to override it, or feed bytes plus an explicit format:

```js
const dec = await wasmpeg.decode(bytes, { format: 'g722' });
```

A bare `Uint8Array` or `Blob` (without a `.name`) carries no hint at all, so name-only formats
need the explicit `{ format }` in that case.

### A PNG or FLAC opens but produces no frames

This is the classic **zlib-missing** symptom — the stream opens but dimensions can't be
resolved. zlib is enabled in the shipped builds; this only bites custom builds that drop it.
See [Configuration](/docs/build/configuration/).

### "input stream is empty — no frames decoded"

**Symptom:** a filter command (`scale()`, `run(['-vf', …])`) throws this immediately.

The decoder opened but the first `nextFrame()` returned nothing — an audio-only file, a
zero-length stream, or a container whose only video stream couldn't be decoded. Probe first to
confirm there's a video stream (`info.streams.some(s => s.type === 'video')`) before running a
video filter.

## exec() / run() behavior

### My exec()/run() output file is empty

There is no transcode path. `exec(['-i','in.mp4','out.webm'])` returns a decoder and writes
**nothing** — the output token is ignored. Consume the returned pixels/decoder, or use
[`gpu.createEncoder`](/docs/reference/gpu/#createencoder) for image output. See the
[command reference](/docs/reference/exec-commands/).

### My codec / seek / rate flag does nothing

The dispatcher decodes, optionally runs a single-frame video filter, and returns data. A long
list of flags parse cleanly but are **ignored** because there's no output stage to apply them
to: `-c:v`/`-crf`/`-preset`/`-pix_fmt` (no encode here — that's `encode()`),
`-ss`/`-t`/`-to` (no seeking — decode runs frame 0 to EOF), `-r`/`-ar`/`-ac` (no rate or
channel conversion), `-frames`/`-vframes` (filter path is always one frame),
`-filter_complex`/`-lavfi`, and multiple `-i` inputs (single input only). Full list:
[accepted but ignored options](/docs/reference/exec-commands/#accepted-but-ignored-options).

### My audio filter isn't applied

The dispatcher's audio path returns decoded PCM but does **not** apply `-af` graphs. Filter
audio in the Web Audio graph after [decoding to PCM](/docs/guides/decode-audio/) instead.

### -f doesn't force the demuxer through run()

`run()`/`exec()` parse `-f` but ignore it. To force a demuxer, use the high-level
`decode(input, { format })` or `decodeAudio(input, { format })` — those are the only paths that
take a format override.

## Output and rendering

### Frames look stretched or wrong-sized

When a filtergraph changes dimensions, end it with an explicit integer `scale=W:H` — the
output buffer is sized from that. Expressions like `scale=iw/2`, `scale=-1:720`, and
`pad=…:(oh-ih)/2` aren't evaluated; compute the integers in JS and pass literal values. See
[output sizing](/docs/reference/exec-commands/#output-sizing).

### A geometry filter (crop/pad/transpose) gives a torn image

Same root cause: the output buffer is sized from the `scale=` in the graph, not from what the
geometry filter actually produced. Append an explicit `scale=W:H` matching the final size —
e.g. `crop=640:480:0:0,scale=640:480`, or for `transpose` (which swaps width and height)
`transpose=1,scale=720:1280`. See [geometry filters](/docs/reference/exec-commands/#geometry-filters).

### Grayscale output comes back wrong

The pipeline returns RGBA. Convert through gray and back so the output buffer is RGBA again:
`format=gray,format=rgba`. Ending a graph in a non-RGBA pixel format will misread the bytes.

## FAQ

### Do I need COOP/COEP headers or SharedArrayBuffer?

No. That's the main difference from multi-threaded ffmpeg.wasm — wasmpeg runs on any static
host with no special headers. See [support](/docs/start/support/#no-cross-origin-isolation-needed).

### Can it transcode video to a file?

No. wasmpeg is decode-first: frames, audio, metadata, and single-frame image encode. Use
server-side FFmpeg for file-to-file transcoding.

### Does it block the main thread?

Decoding is synchronous CPU work. For long media, run it in a Web Worker — the API is
identical there.

### Is WebGPU required?

No. It's an optional acceleration for scaling; everything works on the CPU build. See
[WebGPU](/docs/webgpu/).

### Which package — wasmpeg or wasmpeg-full?

`wasmpeg` (LGPL) for almost everyone; `wasmpeg-full` (GPL) only if you need H.264/H.265
encode. Both decode H.264/H.265.

### Can I seek to a timestamp or trim a clip?

No. Decoding runs from the first frame to EOF — there's no `-ss`/`-t`. To reach frame N, decode
and discard up to it; to "trim," keep only the frames in the range you want.

### Does it run in Node, not just the browser?

Yes. `load()` detects Node and reads the `.wasm` from disk. Browser-only inputs (canvas, video
element, `ImageData`) aren't available there, but files, bytes, and URLs all work. See the
[Node guide](/docs/guides/frameworks/nodejs/).

### Why is `duration` null?

The container didn't store a duration (common for streamed or header-light formats). It's
`null`, not `0` — guard before formatting. The other probe fields are still valid.

### Can I change the output sample rate or channel count?

No. Audio decodes to interleaved Float32 at the source rate and channel count; `-ar`/`-ac` are
ignored. Resample and remix in Web Audio (an `AudioContext` will resample when you build an
`AudioBuffer`).

### How do I encode more than one frame?

`encode()` without `frames` walks the whole stream into an image2pipe sequence. For full
control over format, codec, size, and per-frame timing, drive
[`gpu.createEncoder`](/docs/reference/gpu/#createencoder) directly and `pushRgba` your frames.

{{< aside type="tip" >}}
Still stuck? Open an issue with the input format, browser/Node version, and the exact error —
[github.com/wasmpeg/wasmpeg/issues](https://github.com/wasmpeg/wasmpeg/issues).
{{< /aside >}}
