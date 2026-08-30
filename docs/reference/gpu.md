---
title: "Low-level — gpu"
description: "The typed pipeline the higher levels are built on — load, scale, decoders, audio, probe, encoder, benchmarks, and FS — with parameters, return shapes, and lifetime rules for each."
weight: 30
---
```js

```

The typed pipeline that `wasmpeg` and `FFmpeg` are built on. You pass `Uint8Array` bytes or RGBA
buffers directly and manage lifecycles yourself — no input normalization, no format inference.
Every function wraps the [C ABI](/docs/reference/c-abi/) via `ccall` and handles the heap copies for
you. Source: `src/js/gpu.js`.

{{< aside type="caution" title="You own the lifecycle here" >}}
Nothing is auto-closed at this level. Every `createDecoder` / `createDecoderFile` /
`createAudioDecoder` / `createEncoder` must be paired with `close()`, or you leak one of the
shared session slots ([8 for decoders/audio/probe, 4 for encoders](/docs/reference/c-abi/)). The
high-level API does this for you.
{{< /aside >}}

Every function except `load` throws `call gpu.load() first` until the module is loaded.

## load

Loads and initializes the WASM module.

### Signature

```js
await gpu.load(opts?)
```

### Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `opts.wasmPath` | string | auto | Path to the module's `.js`. The matching `.wasm` must sit beside it (same name, `.wasm` extension). |

### Description

Idempotent — a second call resolves immediately. With no `wasmPath`, it loads
`dist/webgpu.js` when `navigator.gpu` is present and `dist/cpu.js` otherwise. In Node it reads
the `.wasm` from disk and passes it as `wasmBinary`, so it works without a browser `fetch`. The
chosen build also fixes what [`hasWebGPU`](#haswebgpu) reports for the rest of the session.

## hasWebGPU

### Signature

```js
gpu.hasWebGPU()
```

### Returns

`true` when `navigator.gpu` was present at load time (so the WebGPU build is active), `false`
otherwise. Always `false` in Node and on the CPU build. `scale` reads this flag to choose between
`scale_webgpu` and `scale` as its default filter.

## scale

Runs a filtergraph over a single raw RGBA8 frame.

### Signature

```js
gpu.scale(srcRgba, srcW, srcH, dstW, dstH, filtergraph?)
```

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `srcRgba` | Uint8Array \| Uint8ClampedArray | Source RGBA8 pixels, `srcW * srcH * 4` bytes, top-to-bottom. |
| `srcW`, `srcH` | number | Source dimensions. |
| `dstW`, `dstH` | number | Output dimensions; the returned buffer is sized to these. |
| `filtergraph` | string | Optional. Defaults to `scale_webgpu=dstW:dstH` on the WebGPU build, `scale=dstW:dstH` on CPU. |

### Returns

A `Uint8ClampedArray` of RGBA8 pixels, `dstW * dstH * 4` bytes (a copy — independent of the WASM
heap). Throws `scale failed: <code>` on a non-zero return from the pipeline.

### Description

Dispatches to `pipeline_run_rgba_gpu` on the WebGPU build, `pipeline_run_rgba` on CPU. If your
custom `filtergraph` resizes to something other than `dstW`/`dstH`, the pipeline converts the
result to fit the buffer you asked for, so keep `dstW`/`dstH` aligned with the graph's output.

### Example

```js
const out = gpu.scale(src, 1920, 1080, 1280, 720);
const fx  = gpu.scale(src, 1280, 720, 1280, 720, 'hflip');
```

## createDecoder

Opens a video decoder from in-memory bytes.

### Signature

```js
gpu.createDecoder(fileBytes, fmtName?)
```

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `fileBytes` | Uint8Array | Encoded container or bitstream bytes. |
| `fmtName` | string | Optional demuxer name to force (`decoder_open_format`); omit to content-probe (`decoder_open`). |

### Returns

A [Decoder object](#decoder-object). Throws `decoder_open failed: <code>` on a negative handle —
out of slots, no video stream, missing codec, or unrecognized data.

### Example

```js
const dec = gpu.createDecoder(new Uint8Array(mp4Bytes));
const raw = gpu.createDecoder(new Uint8Array(dnxhdBytes), 'dnxhd');   // forced demuxer
```

## createDecoderFile

Opens a video decoder from a path already written to [`gpu.FS`](#fs).

### Signature

```js
gpu.createDecoderFile(path)
```

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `path` | string | A path in the Emscripten virtual filesystem. |

### Returns

A [Decoder object](#decoder-object). Throws `decoder_open_file failed: <code>` on failure
(`-2`/`ENOENT` if the path doesn't exist).

### Description

Forces the `image2` demuxer, which makes single-frame images (PNG, JPEG) reliable — the in-memory
pipe demuxers can't always resolve still-image stream parameters. Write the file first, then open
it.

### Example

```js
gpu.FS.writeFile('/input.png', new Uint8Array(bytes));
const dec = gpu.createDecoderFile('/input.png');
```

### Decoder object

The value returned by `createDecoder` and `createDecoderFile`.

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `width` | number | Native frame width in pixels. |
| `height` | number | Native frame height in pixels. |
| `fps` | number | `fps_num / fps_den` (defaults to `25` when the stream reports no rate). |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `nextFrame(dstW?, dstH?)` | `Uint8ClampedArray` \| `null` | Next RGBA8 frame, `dstW*dstH*4` bytes; `null` at end of stream. Defaults to native `width`/`height`. |
| `close()` | `void` | Frees the session slot. |

`nextFrame` reuses one internal heap buffer and grows it only when you ask for a larger frame, so
calling it with a steady size is allocation-free after the first call. The returned array is a
copy, valid after the next `nextFrame`. It throws on a negative decode error and returns `null`
(not throws) at EOF.

## createAudioDecoder

Opens an audio decoder from in-memory bytes.

### Signature

```js
gpu.createAudioDecoder(fileBytes, fmtName?)
```

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `fileBytes` | Uint8Array | Encoded container or bitstream bytes. |
| `fmtName` | string | Optional demuxer name to force; omit to content-probe. |

### Returns

An [AudioDecoder object](#audiodecoder-object). Throws `audio_open failed: <code>` on a negative
handle.

### Example

```js
const aud = gpu.createAudioDecoder(new Uint8Array(mp3Bytes));
const vag = gpu.createAudioDecoder(new Uint8Array(vagBytes), 'kvag');   // non-probing format
```

### AudioDecoder object

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `channels` | number | Channel count of the decoded stream. |
| `sampleRate` | number | Sample rate in Hz. |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `nextSamples()` | `Float32Array` \| `null` | Interleaved 32-bit float samples; `null` at end of stream. |
| `close()` | `void` | Frees the session slot. |

Samples come out interleaved (L,R,L,R,…) at the source sample rate, regardless of the source's
native sample format. `nextSamples` reuses one internal buffer sized for about 4096 samples per
channel and returns a copy each call.

## probe

Reads container and stream metadata without decoding frames. Opens, reads, and closes a probe
session in one call.

### Signature

```js
gpu.probe(fileBytes)
```

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `fileBytes` | Uint8Array | Encoded container bytes. |

### Returns

A plain object. Throws `probe_open failed: <code>` on failure.

```js
{
  format:   string,        // demuxer name, e.g. "mov,mp4,m4a,3gp,3g2,mj2"
  duration: number | null, // seconds, null if unknown
  bitrate:  number,        // overall bitrate in kb/s (-1 if unknown)
  streams:  [{ index: number, type: string }],   // type: video|audio|data|subtitle|attachment|unknown
  video:    { width, height, fpsNum, fpsDen },    // each field -1 if no video stream
  audio:    { sampleRate, channels },             // each field -1 if no audio stream
}
```

`video` and `audio` always exist; their fields are `-1` when the corresponding stream is absent.
`duration` is `null` (not `-1`) when the container reports no duration.

### Example

```js
const info = gpu.probe(new Uint8Array(videoBytes));
if (info.video.width > 0) console.log(`${info.video.width}x${info.video.height}`);
```

## createEncoder

Opens an encoder session that muxes pushed RGBA frames into container bytes.

### Signature

```js
gpu.createEncoder(opts)
```

### Parameters

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `fmt` | string | **required** | Container/muxer name (`'image2pipe'`, `'mp4'`, `'webm'`, `'wav'`, …). Throws `createEncoder: fmt is required` if missing. |
| `codec` | string | **required** | Encoder name (`'mjpeg'`, `'png'`, `'aac'`, …). Throws `createEncoder: codec is required` if missing. |
| `width` | number | `0` | Frame width (`0` for audio-only muxers). |
| `height` | number | `0` | Frame height. |
| `fps` | number \| `{num,den}` | `30` | Frame rate. A number becomes `num/1`; an object is used as-is. |
| `bitrate` | number | `0` | Target bitrate in bits/s (`0` = codec default). |

### Returns

An [Encoder object](#encoder-object). Throws `encoder_open failed: <code>` on a negative handle —
out of slots, unknown codec (`AVERROR_ENCODER_NOT_FOUND`), or unknown format.

### Description

The session picks the codec's first supported pixel format and converts each RGBA frame into it.
For a single-frame image grab use `image2pipe` (which writes one stream to in-memory IO);
`image2` expects numbered files on a real filesystem and won't work here.

### Example

```js
const enc = gpu.createEncoder({ fmt: 'image2pipe', codec: 'mjpeg', width: 1280, height: 720 });
enc.pushRgba(rgbaData, 1280, 720, 0);
const output = enc.finish();   // Uint8Array of JPEG bytes
enc.close();
```

### Encoder object

| Method | Returns | Description |
|--------|---------|-------------|
| `pushRgba(rgba, w, h, ptsMs?)` | `void` | Encode one RGBA8 frame at timestamp `ptsMs` milliseconds (default `0`). Throws on a negative encode error. |
| `finish()` | `Uint8Array` | Flush, write the trailer, and return a copy of the muxed bytes. Throws if the encoder produced no output. |
| `close()` | `void` | Free the session. Call after `finish` — the output buffer is freed here. |

`finish` copies the output before returning, so the bytes stay valid after `close`. Call `finish`
exactly once.

## Benchmarks

Both return average milliseconds per scale iteration over an internally generated frame, for
comparing CPU and GPU paths.

### benchCpu

```js
gpu.benchCpu(srcW, srcH, dstW, dstH, iters)   // → ms/frame
```

### benchGpu

```js
gpu.benchGpu(srcW, srcH, dstW, dstH, iters)   // → ms/frame
```

`benchGpu` is only meaningful on the WebGPU build; on the CPU build the underlying symbol isn't
exported. See [WebGPU](/docs/webgpu/) for how to surface these in a UI.

## FS

```js
gpu.FS
```

The Emscripten `FS` object — read and write the WASM virtual filesystem directly (`writeFile`,
`readFile`, `mkdir`, `readdir`, …). Used together with [`createDecoderFile`](#createdecoderfile).
`null` until `gpu.load()` resolves.
