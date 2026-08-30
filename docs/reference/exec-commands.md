---
title: "Command reference"
description: "Every FFmpeg-style argument the wasmpeg dispatcher understands — input selection, video filtering, frame sizing, audio routing, and the options that are accepted but have no effect."
weight: 40
---
This page documents the FFmpeg-style command surface exposed by the dispatcher in
`src/js/exec.mjs`. It is reached three ways, all of which share the same parsing and
routing:

- [`wasmpeg.run(input, args)`](/docs/reference/high-level/#run) — high-level, accepts any input type.
- [`ff.exec(args)`](/docs/reference/ffmpeg-class/#exec) — the `FFmpeg` class; reads `-i` from the virtual filesystem.
- `exec(input, args)` — the underlying function, imported directly.

The dispatcher is **not** a complete FFmpeg CLI. It decodes an input, optionally runs a
single-frame filtergraph, and returns the result in memory. There is no output-file or
transcode path. Each section below describes one part of the surface; options that are
parsed but ignored are documented in [Accepted but ignored options](#accepted-but-ignored-options).

## Synopsis

```js
exec(input, args)
```

`args` is an FFmpeg-style argument array (or a single string, which is tokenized). The
return value depends on the operation:

| Operation | Trigger | Returns |
|-----------|---------|---------|
| Filter | a video filter is present (`-vf`, `-s`) | `Uint8ClampedArray` of RGBA8 pixels |
| Decode | input only, no filter | a [Decoder](/docs/reference/high-level/#decoder-object) |
| Audio | `-af` or `-vn` | an [AudioDecoder](/docs/reference/high-level/#audiodecoder-object) |

## Argument parsing

Arguments are tokenized with shell-style quoting, then classified against two tables in
`exec.mjs`: value-flags (which consume the next token, e.g. `-vf`, `-ss`, `-c:v`) and
boolean-flags (which stand alone, e.g. `-an`, `-vn`, `-shortest`). Stream-specifier
suffixes are normalized, so `-c:v`, `-filter:v`, and `-frames:v` are recognized by their
base flag. Tokens that are not flags and not flag values are treated as output URLs.

This means malformed or unknown flags will not crash parsing — but only the flags
documented below have any effect.

## Input selection

### -i &lt;input&gt;

Names the input. With `wasmpeg.run`/`exec`, the actual bytes come from the `input`
argument and `-i` is largely nominal; with `ff.exec`, the `-i` value is a path read from
the virtual filesystem.

```js
await wasmpeg.run(file, ['-i', 'in.mp4']);          // input is `file`
await ff.exec(['-i', 'in.mp4']);                     // reads /in.mp4 from the FS
```

`ff.exec` throws if no `-i` is given. Only a single input is supported; see
[Multiple inputs](#multiple-inputs).

## Decode-only invocation

With an input and no filter, the dispatcher opens a decoder and returns it. Pull frames
with `nextFrame()`.

```js
const dec = await wasmpeg.run(file, ['-i', 'in.mp4']);
let frame;
while ((frame = dec.nextFrame())) { /* RGBA8 */ }
dec.close();
```

Format detection is automatic for self-describing containers (MP4/MOV, WebM/MKV, OGG).
Raw bitstreams and formats that do not content-probe will fail here — `exec` does not
pass a demuxer hint. Use [`wasmpeg.decode(input, { format })`](/docs/guides/decode-video/#forcing-a-demuxer)
for those.

## Video filtering: -vf

`-vf` (and its alias `-filter:v`) supplies a filtergraph. The dispatcher decodes the
**first frame**, runs the graph, and returns RGBA8 pixels.

```js
const px = await wasmpeg.run(file, ['-vf', 'scale=1280:720']);
```

{{< aside type="note" >}}
Filtering is single-frame. A `-vf` invocation always returns one frame's pixels, never a
stream. To filter every frame, open a [decoder](/docs/guides/decode-video/) and scale per
frame, or push frames through [`gpu.createEncoder`](/docs/reference/gpu/#createencoder).
{{< /aside >}}

### Output sizing

The dimensions of the returned buffer are read from the **`scale=` token** in the graph
(`scale=W:H` or `scale=w=W:h=H`, integers only). If the graph has no `scale=`, the output
is reported at the source frame's dimensions. Getting this wrong produces a buffer whose
size disagrees with the actual filtered frame, so the rule of thumb is: **include an
explicit integer `scale=` whenever the graph changes dimensions.**

### scale

```js
await wasmpeg.run(file, ['-vf', 'scale=1280:720']);
await wasmpeg.run(file, ['-vf', 'scale=w=1280:h=720']);   // w=/h= form also recognized
```

### Filter chains

Any chain that includes an explicit integer `scale=` works, and the output is sized from
that `scale=`:

```js
await wasmpeg.run(file, ['-vf', 'scale=1280:720,hflip']);
await wasmpeg.run(file, ['-vf', 'scale=640:360,eq=contrast=1.2,gblur=sigma=2']);
```

### Same-size filters

Filters that do not change dimensions can be used without a `scale=`; the output is
returned at the source size:

```js
await wasmpeg.run(file, ['-vf', 'hflip']);
await wasmpeg.run(file, ['-vf', 'negate']);
```

### Geometry filters

`crop`, `pad`, and `transpose` change dimensions but are not read by the sizing logic.
Pair them with an explicit `scale=` set to the final dimensions:

```js
// crop a 640×480 region
await wasmpeg.run(file, ['-vf', 'crop=640:480:0:0,scale=640:480']);

// transpose swaps width/height — scale to the swapped size
await wasmpeg.run(file, ['-vf', 'transpose=1,scale=720:1280']);
```

Without the trailing `scale=`, the returned buffer is sized to the source frame and will
not match the filtered output.

### Size expressions and -1

Only **literal integers** are parsed from `scale=`. Expressions and auto values are not
read, so the output buffer is mis-sized:

```js
// Not supported — sizes are not computed
await wasmpeg.run(file, ['-vf', 'scale=iw/2:ih/2']);
await wasmpeg.run(file, ['-vf', 'scale=-1:720']);
```

Compute the target dimensions in JavaScript and pass integers instead.

### scale_webgpu

On the WebGPU build, the GPU scale filter is available and is sized the same way:

```js
await wasmpeg.run(file, ['-vf', 'scale_webgpu=1280:720']);
```

`wasmpeg.scale()` selects `scale_webgpu` automatically when the WebGPU build is active;
this is only needed to force it. See [WebGPU](/docs/webgpu/).

## Frame size shorthand: -s

`-s WxH` is shorthand for `scale=W:H` when no `-vf` is present:

```js
await wasmpeg.run(file, ['-s', '1280x720']);   // equivalent to -vf scale=1280:720
```

If both `-vf` and `-s` are present, `-vf` wins.

## Audio routing: -af and -vn

An `-af`/`-filter:a` value, or `-vn` with no video filter, routes the input to an audio
decoder and returns an [AudioDecoder](/docs/reference/high-level/#audiodecoder-object).

```js
const aud = await wasmpeg.run(file, ['-vn']);
let chunk;
while ((chunk = aud.nextSamples())) { /* Float32, interleaved */ }
aud.close();
```

{{< aside type="caution" title="Audio filters are not applied" >}}
The dispatcher routes to audio decode, but the `-af` filtergraph itself is **not
applied** — you receive decoded PCM, not filtered audio. The demuxer hint is also not
passed on this path. Filter audio with a [filtergraph through the decoder](/docs/guides/decode-audio/)
or in the Web Audio graph instead.
{{< /aside >}}

## Return values

A filter operation returns a `Uint8ClampedArray` of RGBA8 pixels. A decode-only
invocation returns a Decoder; an audio invocation returns an AudioDecoder. `ff.exec`
additionally requires the `-i` path to exist in the virtual filesystem and throws
otherwise.

## Accepted but ignored options

The following options are tokenized so they do not break parsing, but they have **no
effect** on the operation. Output URLs are the important case: they are parsed and then
silently discarded, so nothing is written.

### Output files and transcoding

```js
await wasmpeg.run(file, ['-i', 'in.mp4', 'out.webm']);   // returns a decoder; writes nothing
```

There is no muxing or file-to-file transcode path. The output token (`out.webm`,
`out.mp4`, `out.gif`, …) is dropped. For image output, push frames through
[`gpu.createEncoder`](/docs/reference/gpu/#createencoder).

### Codec and encoder selection

`-c:v`, `-vcodec`, `-c:a`, `-acodec`, `-b:v`, `-b:a`, `-crf`, `-preset`, `-profile`,
`-level`, `-pix_fmt`, `-qscale` — parsed, ignored. The decode path uses the demuxer's
codec; the encode path is configured through `gpu.createEncoder`, not these flags.

### Seeking and trimming

`-ss`, `-t`, `-to`, `-sseof` — ignored. Decoding always begins at the first frame and
runs to end of stream. There is no random access.

### Frame rate, sample rate, channels

`-r`, `-framerate`, `-ar`, `-ac` — ignored. The only rate-like option honored is `-s`
(frame size). Resample audio with a decoder-side filtergraph or in Web Audio.

### Frame counts

`-frames`, `-vframes`, `-aframes` — ignored. A `-vf` invocation returns exactly one
frame; a decode invocation returns a decoder you control. To cap encoded frames, use the
high-level [`encode({ frames })`](/docs/reference/high-level/#encode).

### Complex filtergraphs

`-filter_complex` and `-lavfi` are read as values but never applied. Only `-vf`/`-af` are
acted on, so a `-filter_complex` invocation falls through to a plain decoder.

### Multiple inputs

Only the first input is used. Multi-input graphs (`overlay`, `concat`, `hstack`,
`amerge`, …) that require two `-i` sources cannot be expressed, because the filter source
is a single buffer.

### Demuxer forcing

`-f <demuxer>` is parsed but the decoder is opened without a format hint, so non-probing
formats will not open through `exec`. Use
[`wasmpeg.decode(input, { format })`](/docs/guides/decode-video/#forcing-a-demuxer), which
passes the hint to `decoder_open_format`.

### Informational commands

`-version`, `-formats`, `-codecs`, `-filters`, `-h` — no `ffmpeg`/`ffprobe` CLI is
compiled into the binary. With `ff.exec`, these throw `no -i input`; with `wasmpeg.run`,
they require an input and still produce no report.

### Stream mapping and metadata

`-map`, `-map_metadata`, `-metadata`, `-disposition`, and bitstream filters (`-bsf`,
`-bsf:v`, `-bsf:a`) are parsed and ignored.

## Safe subset for a command palette

If you are exposing raw argument arrays in a UI (a command bar, a search box), the
reliable surface is small and worth allow-listing explicitly:

- `-i <input>` — decode-only, returns a Decoder.
- `-vf <graph>` where `<graph>` contains an explicit integer `scale=W:H`, or is a
  same-size filter (`hflip`, `vflip`, `negate`, …).
- `-s WxH` — frame-size shorthand.
- `scale_webgpu=W:H` — on the WebGPU build.

Treat everything in [Accepted but ignored options](#accepted-but-ignored-options) and the
audio-filter caveat as unsupported until a transcode/seek path exists.
