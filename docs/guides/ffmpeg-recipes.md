---
title: "FFmpeg → wasmpeg"
description: "The FFmpeg commands you already know, mapped one-to-one to the wasmpeg call that does the same thing."
weight: 70
---
If you know FFmpeg, you already know wasmpeg — you just call a method instead of spawning
a process. Each recipe below shows the **FFmpeg command** and the **wasmpeg equivalent**
side by side. All examples assume:

```js

await wasmpeg.load();
```

`input` is anything wasmpeg accepts — a `File`, `Blob`, URL, `Uint8Array`, `ArrayBuffer`,
`HTMLVideoElement`, `HTMLCanvasElement`, or `ImageData`.

## How the mapping works

wasmpeg isn't FFmpeg-the-CLI in a browser. There's no process, no virtual command line, and
no output file. What the recipes call "the FFmpeg command" is the shape of the task you're
used to; the wasmpeg side is a single method that gets the same result out as data — pixels,
samples, metadata, or encoded image bytes.

Three things follow from that, and they explain every caveat on this page:

- **There is no output container.** A command like `ffmpeg -i in.mp4 out.webm` mux-and-writes
  a file. wasmpeg never writes one. It hands you the decoded result and you do what you want
  with it. See [No direct equivalent](#no-direct-equivalent-yet) for the workflows this rules
  out.
- **Filtering is single-frame.** `wasmpeg.scale()` and `wasmpeg.run(..., ['-vf', …])` decode
  one frame and run the graph on it, returning RGBA pixels. They don't stream a whole video
  through a filter. To filter every frame, decode in a loop and scale each frame yourself.
- **Output size comes from a literal `scale=W:H`.** The dispatcher reads the output buffer
  size from an integer `scale=W:H` in the graph. Expressions (`iw/2`, `-1`, `oh-ih`) aren't
  evaluated, so any graph that changes dimensions has to end in a concrete `scale=`.

The recipes below are grouped by what you get back: metadata, pixels, frames, audio, and
encoded images.

## Cheat sheet

| FFmpeg | wasmpeg | Returns |
|--------|---------|---------|
| `ffprobe input.mp4` | `wasmpeg.probe(input)` | metadata object |
| `ffmpeg -i in -frames:v 1 thumb.jpg` | `wasmpeg.encode(input, { codec: 'mjpeg', frames: 1 })` | JPEG bytes |
| `ffmpeg -i in -vf scale=W:H out.png` | `wasmpeg.scale(input, W, H)` | RGBA pixels |
| `ffmpeg -i in frame_%04d.png` | `wasmpeg.decode(input)` + loop | per-frame RGBA |
| `ffmpeg -i in -vn out.wav` | `wasmpeg.decodeAudio(input)` | Float32 PCM |
| `ffmpeg -i in.png out.jpg` | `wasmpeg.encode(input, { codec: 'mjpeg' })` | JPEG bytes |
| `ffmpeg -f fmt -i in …` | `wasmpeg.decode(input, { format: 'fmt' })` | Decoder |

## Inspect a file

```sh
# FFmpeg
ffprobe -v quiet -show_format -show_streams input.mp4
```

```js
// wasmpeg
const info = await wasmpeg.probe(input);
// info.format, info.duration, info.bitrate, info.streams, info.video, info.audio
```

`probe()` reads container and stream headers without decoding a single frame, so it's cheap
and a good first call when you're not sure what you've been handed. The shape it returns:

```js
{
  format:   'mov,mp4,m4a,3gp,3g2,mj2',  // demuxer name, may list several
  duration: 12.5,                        // seconds, or null if the container omits it
  bitrate:  2480,                        // overall, kb/s
  streams:  [{ index: 0, type: 'video' }, { index: 1, type: 'audio' }],
  video:    { width: 1920, height: 1080, fpsNum: 30000, fpsDen: 1001 },
  audio:    { sampleRate: 48000, channels: 2 },
}
```

The frame rate is exposed as a numerator/denominator pair so values like 29.97
(`30000/1001`) stay exact; divide when you need a float. `duration` is `null` for streamed or
header-light formats — guard it before calling `.toFixed()`.

→ [Probe guide](/docs/guides/probe/)

## Grab a thumbnail (first frame)

```sh
# FFmpeg
ffmpeg -i input.mp4 -frames:v 1 -q:v 2 thumb.jpg
```

```js
// wasmpeg — returns JPEG bytes
const jpg = await wasmpeg.encode(input, { codec: 'mjpeg', frames: 1 });
```

`frames: 1` stops after the first decoded frame. The bytes are a complete JPEG file, ready to
drop into a `Blob`:

```js
const url = URL.createObjectURL(new Blob([jpg], { type: 'image/jpeg' }));
img.src = url;
```

FFmpeg's `-q:v` quality knob has no direct equivalent here — `encode()` exposes `bitrate`
(bits/s, `0` for the codec default) rather than a qscale. For a lossless still, encode with
`codec: 'png'` instead.

## Thumbnail at a specific size

```sh
# FFmpeg
ffmpeg -i input.mp4 -frames:v 1 -vf scale=320:180 thumb.jpg
```

```js
// wasmpeg
const jpg = await wasmpeg.encode(input, { codec: 'mjpeg', width: 320, height: 180, frames: 1 });
```

`width`/`height` on `encode()` set the encoded frame size directly — no `scale=` filter
needed, because the decoder resamples to that size as it reads. Leave them off to keep the
source dimensions.

## Resize a frame

```sh
# FFmpeg
ffmpeg -i input.mp4 -vf scale=1280:720 out.png
```

```js
// wasmpeg — RGBA8 pixels at 1280×720
const rgba = await wasmpeg.scale(input, 1280, 720);

// or, while decoding, scale each frame straight to size:
const dec = await wasmpeg.decode(input);
const small = dec.nextFrame(1280, 720);
```

→ [Scale & filter guide](/docs/guides/scale-filter/)

## Crop

```sh
# FFmpeg
ffmpeg -i input.mp4 -vf crop=640:480:0:0 out.png
```

```js
// wasmpeg — append an explicit scale= so the output is sized correctly
const rgba = await wasmpeg.scale(input, 640, 480, 'crop=640:480:0:0,scale=640:480');
```

{{< aside type="caution" >}}
Geometry filters (`crop`, `pad`, `transpose`) must be followed by an explicit integer
`scale=W:H` — the dispatcher reads output dimensions from the `scale=`. See
[geometry filters](/docs/reference/exec-commands/#geometry-filters).
{{< /aside >}}

The rule is mechanical: the output buffer is allocated from whatever integer `scale=W:H` the
dispatcher finds in the graph (or from the second/third argument to `scale()`). A `crop` that
narrows the frame to 640×480 changes the picture's real size, but the dispatcher doesn't track
that — so it writes a `scale=640:480` of its own only if the dimensions you passed match.
Putting the explicit `scale=` at the end of the chain makes intent and buffer size agree.

## Flip & rotate

```sh
# FFmpeg
ffmpeg -i input.mp4 -vf hflip out.png
ffmpeg -i input.mp4 -vf transpose=1 out.png   # rotate 90° clockwise
```

```js
// wasmpeg — keep an explicit scale= in the graph
const flipped = await wasmpeg.scale(input, 1280, 720, 'scale=1280:720,hflip');

// transpose swaps width/height — scale to the swapped size:
const rotated = await wasmpeg.scale(input, 720, 1280, 'transpose=1,scale=720:1280');
```

## Apply any filtergraph

```sh
# FFmpeg
ffmpeg -i input.mp4 -vf "scale=1280:720,eq=contrast=1.2,gblur=sigma=2" out.png
```

```js
// wasmpeg
const rgba = await wasmpeg.scale(input, 1280, 720, 'scale=1280:720,eq=contrast=1.2,gblur=sigma=2');

// equivalent low-level form:
const rgba2 = await wasmpeg.run(input, ['-vf', 'scale=1280:720,eq=contrast=1.2,gblur=sigma=2']);
```

Any filter compiled into the build works — see the [filter reference](/docs/formats/filters/) for the
full list with per-filter examples.

A few things to keep straight when porting a `-vf` string verbatim:

- **One frame, not the stream.** The graph runs on the first decoded frame only. There's no
  `-frames`/`-vframes` to set; the command stops after one frame regardless.
- **No `-filter_complex` / `-lavfi`.** Single linear chain, single input. Filters that pull
  from multiple pads (`overlay`, `concat`, `hstack`) have no input to draw from.
- **Audio filters in a video graph are dropped.** Mixing `-vf` and `-af` only applies the
  video side; see [Filter audio](#filter-audio) for what to do with `-af`.

## Filter every frame, not just the first

There's no command form for "run this `-vf` across the whole video." Decode in a loop and run
the graph on each frame with `wasmpeg.run`:

```sh
# FFmpeg
ffmpeg -i input.mp4 -vf "scale=640:360,eq=contrast=1.2" frames_%04d.png
```

```js
// wasmpeg — filter each decoded frame in turn
const dec = await wasmpeg.decode(input);
try {
    let frame;
    while ((frame = dec.nextFrame())) {
        const img = new ImageData(frame, dec.width, dec.height);
        const filtered = await wasmpeg.run(img, ['-vf', 'scale=640:360,eq=contrast=1.2']);
        // filtered: Uint8ClampedArray of RGBA8 at 640×360
    }
} finally {
    dec.close();
}
```

Wrapping each decoded frame in `ImageData` lets `run()` filter raw pixels without a second
decode — its filter path accepts `ImageData`, a canvas, or a video element directly, the same
RGBA it would have produced from a file. (Outside a browser, where `ImageData` isn't defined,
filter the source file once per call instead.)

## Convert to grayscale

```sh
# FFmpeg
ffmpeg -i input.mp4 -vf format=gray out.png
```

```js
// wasmpeg — convert through gray, back to rgba for output
const rgba = await wasmpeg.scale(input, 1280, 720, 'scale=1280:720,format=gray,format=rgba');
```

## Color grade

```sh
# FFmpeg
ffmpeg -i input.mp4 -vf eq=contrast=1.2:brightness=0.04:saturation=1.1 out.png
```

```js
// wasmpeg
const rgba = await wasmpeg.scale(input, 1280, 720,
  'scale=1280:720,eq=contrast=1.2:brightness=0.04:saturation=1.1');
```

## Blur or sharpen

```sh
# FFmpeg
ffmpeg -i input.mp4 -vf gblur=sigma=3 out.png      # blur
ffmpeg -i input.mp4 -vf unsharp=5:5:1.0 out.png    # sharpen
```

```js
// wasmpeg
const blurred   = await wasmpeg.scale(input, 1280, 720, 'scale=1280:720,gblur=sigma=3');
const sharpened = await wasmpeg.scale(input, 1280, 720, 'scale=1280:720,unsharp=5:5:1.0');
```

## Letterbox / pad to an aspect ratio

```sh
# FFmpeg
ffmpeg -i input.mp4 -vf "scale=1280:-1,pad=1280:720:0:(oh-ih)/2:black" out.png
```

```js
// wasmpeg — compute the integer pad offset in JS, then pass literal values
const padY = Math.round((720 - 540) / 2);   // e.g. a 1280×540 source
const rgba = await wasmpeg.scale(input, 1280, 720,
  `scale=1280:540,pad=1280:720:0:${padY}:black,scale=1280:720`);
```

## Decode every frame

```sh
# FFmpeg
ffmpeg -i input.mp4 frame_%04d.png
```

```js
// wasmpeg — process frames in memory instead of writing files
const dec = await wasmpeg.decode(input);
let frame;
while ((frame = dec.nextFrame())) {
    // frame: Uint8ClampedArray of RGBA8 (dec.width × dec.height)
}
dec.close();
```

→ [Decode video guide](/docs/guides/decode-video/)

## Extract audio as PCM

```sh
# FFmpeg
ffmpeg -i input.mp4 -vn -f f32le -acodec pcm_f32le audio.raw
```

```js
// wasmpeg — interleaved Float32 samples, ready for Web Audio
const aud = await wasmpeg.decodeAudio(input);
let chunk;
while ((chunk = aud.nextSamples())) {
    // chunk: Float32Array, interleaved, [-1, 1]
}
aud.close();
```

The output is always interleaved 32-bit float in `[-1, 1]` at the source sample rate —
there's no `-ar`/`-ac`/`-sample_fmt` to change rate, channel count, or sample format. Read
`aud.sampleRate` and `aud.channels`, then deinterleave or resample on your side (Web Audio's
`AudioContext` will resample for you when you build an `AudioBuffer`). For the full
chunk-to-`AudioBuffer` routine, see the [Examples](/docs/guides/examples/) page.

→ [Decode audio guide](/docs/guides/decode-audio/)

## Filter audio

```sh
# FFmpeg
ffmpeg -i input.mp4 -af "volume=0.5,highpass=f=200" out.wav
```

```js
// wasmpeg — -af graphs are NOT applied; decode to PCM, then filter in Web Audio
const aud = await wasmpeg.decodeAudio(input);
// gain, EQ, etc. belong in the AudioContext graph (GainNode, BiquadFilterNode, …)
```

The dispatcher parses `-af` so the command doesn't error, but it doesn't run the audio graph —
you get untouched PCM back. Apply gain, EQ, and filters with Web Audio nodes after decoding.

## Convert an image format

```sh
# FFmpeg
ffmpeg -i input.png output.jpg
```

```js
// wasmpeg
const jpg = await wasmpeg.encode(pngInput, { codec: 'mjpeg' });
const png = await wasmpeg.encode(canvas,   { codec: 'png' });
```

## Force a demuxer for a format that won't probe

```sh
# FFmpeg
ffmpeg -f dnxhd -i input.raw ...
```

```js
// wasmpeg — pass { format } (not supported through run()/exec())
const dec = await wasmpeg.decode(input, { format: 'dnxhd' });
```

`-f` only forces the demuxer; it doesn't affect output, since there is none. wasmpeg accepts
it as the `format` option on the high-level `decode()` and `decodeAudio()`. For many formats
you don't need it — when the source carries a recognizable filename (a `File.name`, a URL
path), wasmpeg infers the demuxer from the extension for containers that don't content-probe.
`{ format }` is the override when there's no name or the guess is wrong.

The `-f` on `run()`/`exec()` is parsed but ignored: those take a single positional input and
have no `format` parameter. Reach for `decode()` whenever you need to name the demuxer.

## GPU-accelerated scale

```sh
# FFmpeg (with a WebGPU-enabled build)
ffmpeg -i input.mp4 -vf scale_webgpu=1280:720 out.png
```

```js
// wasmpeg — automatic on a WebGPU browser; scale() picks scale_webgpu for you.
// To force it explicitly:
const rgba = await wasmpeg.run(input, ['-vf', 'scale_webgpu=1280:720']);
```

→ [WebGPU (experimental)](/docs/webgpu/)

## No direct equivalent (yet)

wasmpeg is **decode-first** — it gets pixels, samples, and metadata out and runs
single-frame filtergraphs. The following FFmpeg workflows have **no wasmpeg equivalent**;
there's no output-container/transcode path.

| FFmpeg | Why there's no equivalent |
|--------|---------------------------|
| `ffmpeg -i in.mp4 out.webm` | No file-to-file transcode / muxing. |
| `ffmpeg -ss 30 -t 10 -i in.mp4 …` | No seeking or trimming — decode runs from frame 0 to EOF. |
| `ffmpeg -i in.mp4 -r 24 …` | No frame-rate conversion. |
| `ffmpeg -i a.mp4 -i b.mp4 -filter_complex concat …` | Single input only; no multi-input / `-filter_complex`. |
| `ffmpeg -i v.mp4 -i a.mp3 -c copy out.mp4` | No audio+video muxing. |
| `ffmpeg -i in.mov -c:v libx264 out.mp4` | H.264/H.265 **encode** is GPL-only and not published to npm yet; even there, output is per-frame, not a muxed file. |

For multi-frame or image output, push frames through
[`gpu.createEncoder`](/docs/reference/gpu/#createencoder) yourself. For full
transcoding, run FFmpeg server-side.

### Why no transcode?

The build is decode-first by design: a smaller binary, no muxers wired into the dispatcher,
and no need for the cross-origin isolation that multi-threaded encode pipelines pull in. The
single-frame `encode()` path covers the common browser job — grab a still — without dragging in
a full mux/encode stack. If your app genuinely needs file-to-file conversion, that work is
better done on a server where FFmpeg can use threads and write real files. wasmpeg's job is
getting pixels, samples, and metadata into the page.

{{< aside type="tip" >}}
Building a command palette or search over these? The
[exec() command support](/docs/reference/exec-commands/) page lists exactly which raw arg
arrays are safe to expose.
{{< /aside >}}
