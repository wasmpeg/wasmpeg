---
title: "C ABI"
description: "Every EMSCRIPTEN_KEEPALIVE function exported from the WASM module — signatures, parameters, return values, and lifetime rules — for embedding the raw binary yourself."
weight: 60
---
Every JS layer ultimately calls these `EMSCRIPTEN_KEEPALIVE` functions through Emscripten's
`ccall`. You only need this page if you're embedding the raw WASM module directly instead of
going through `wasmpeg`, `gpu`, or `FFmpeg`. Source: `src/pipeline.c`; the exact export list
is assembled in `scripts/build.sh`.

The two builds export slightly different sets. Both ship the common functions below; only the
WebGPU build (`dist/webgpu.js`) additionally exports `pipeline_run_rgba_gpu` and
`bench_scale_webgpu`. On the CPU build (`dist/cpu.js`) those two symbols are not present, and
calling them through `ccall` throws rather than returning an error code.

{{< aside type="note" title="Sessions" >}}
Video decoders, audio decoders, and probes each have their own pool of **8 slots** (handles
0–7); encoders have a separate pool of **4** (handles 0–3). An `*_open` call scans for the
first inactive slot and returns its index, or `AVERROR(ENOMEM)` (`-12`) when the pool is full.
A slot stays occupied until the matching `*_close`, so always pair them.
{{< /aside >}}

## Calling convention

Functions take and return `int`/`double`/pointers as plain numbers. Pass a buffer by copying
it into the WASM heap and handing over the pointer; read a buffer back out of `HEAPU8` and copy
it before you free anything.

```js
const ptr = mod._malloc(bytes.byteLength);
mod.HEAPU8.set(bytes, ptr);
const ret = mod.ccall('decoder_open', 'number', ['number', 'number'], [ptr, bytes.byteLength]);
mod._free(ptr);
```

`ccall` type strings: `'number'` for any int, float, or pointer; `'string'` for a `const char *`
argument or return; `null` for `void`. The module exposes `_malloc`, `_free`, `HEAPU8`, `ccall`,
`cwrap`, and `FS` as runtime methods.

Unless noted otherwise, every function that returns `int` returns `0` (or a non-negative count)
on success and a negative [`AVERROR`](/docs/reference/errors/) on failure. Accessor functions return
`-1` for an invalid or closed handle.

## Version

### pipeline_version

```c
const char *pipeline_version(void);
```

Returns FFmpeg's `av_version_info()` string (for example `"7.1"` or a git description). No
session needed.

```js
const v = mod.ccall('pipeline_version', 'string', [], []);
```

## Scale pipeline

### pipeline_run_rgba

```c
int pipeline_run_rgba(const uint8_t *src_rgba, int src_w, int src_h,
                      uint8_t *dst_rgba,       int dst_w, int dst_h,
                      const char *filtergraph);
```

Runs `filtergraph` over a single row-major RGBA8 frame and writes the result to `dst_rgba`.

| Param | Meaning |
|-------|---------|
| `src_rgba` | Source pixels, `src_w * src_h * 4` bytes, top-to-bottom, no padding. |
| `src_w`, `src_h` | Source dimensions. |
| `dst_rgba` | Caller-allocated output buffer, `dst_w * dst_h * 4` bytes. |
| `dst_w`, `dst_h` | Output dimensions. If the graph's output isn't RGBA or doesn't match these, it's converted/scaled with `SWS_BILINEAR` to fit. |
| `filtergraph` | An FFmpeg filtergraph string, e.g. `"scale=1280:720"` or `"hflip"`. |

Returns `0` on success or a negative `AVERROR`. The function builds a fresh filter graph on each
call (input pix_fmt RGBA, time base 1/25), so it's stateless across invocations.

### pipeline_run_rgba_gpu

```c
int pipeline_run_rgba_gpu(const uint8_t *src_rgba, int src_w, int src_h,
                          uint8_t *dst_rgba,       int dst_w, int dst_h,
                          const char *filtergraph);
```

Same signature and contract as `pipeline_run_rgba`, but uploads the frame to a WebGPU hardware
frames context, runs the graph on the GPU, and reads it back. Pair it with a GPU filter such as
`scale_webgpu=W:H`. **WebGPU build only** — the symbol isn't exported on the CPU build.

## Benchmarks

### bench_scale_cpu

```c
double bench_scale_cpu(int src_w, int src_h, int dst_w, int dst_h, int n);
```

Scales an internally allocated mid-gray frame `scale=dst_w:dst_h` for `n` iterations and returns
the **average** wall-clock time per iteration in milliseconds. Returns `-1.0` if allocation fails.

### bench_scale_webgpu

```c
double bench_scale_webgpu(int src_w, int src_h, int dst_w, int dst_h, int n);
```

The GPU counterpart, using `scale_webgpu`. Returns ms/iteration. The C body returns `-1.0` when
the binary is compiled without WebGPU, but on the CPU build the symbol isn't exported, so reach
for it only on the WebGPU build.

## Video decoder

A decode session holds the input bytes, an in-memory `AVIOContext`, the demuxer, the codec, and a
reusable `SwsContext` for RGBA conversion.

### decoder_open

```c
int decoder_open(const uint8_t *data, int size);
```

Copies `size` bytes from `data` into an internal buffer, opens it through a seekable in-memory IO
layer, finds the first video stream, and opens its decoder. Returns a handle (0–7), or a negative
`AVERROR`: `AVERROR(ENOMEM)` if no slot is free, `AVERROR_STREAM_NOT_FOUND` if there's no video
stream, `AVERROR_DECODER_NOT_FOUND` if the codec isn't in the build, or a demuxer error for
unrecognized data.

### decoder_open_format

```c
int decoder_open_format(const uint8_t *data, int size, const char *fmt_name);
```

Same as `decoder_open`, but forces the demuxer named by `fmt_name` (via `av_find_input_format`)
instead of probing. Use this for raw bitstreams and container formats that carry no magic bytes.
A wrong or absent demuxer name surfaces as a negative `AVERROR`.

### decoder_open_file

```c
int decoder_open_file(const char *path);
```

Opens a file already present in the Emscripten virtual filesystem at `path`, forcing the `image2`
demuxer. This is the reliable path for single-frame images (PNG, JPEG): the pipe demuxers used on
the in-memory path can't always resolve still-image stream parameters. Returns a handle or a
negative `AVERROR` (`-2`/`ENOENT` if the path doesn't exist).

### decoder_width / decoder_height / decoder_fps_num / decoder_fps_den

```c
int decoder_width(int handle);
int decoder_height(int handle);
int decoder_fps_num(int handle);
int decoder_fps_den(int handle);
```

Stream geometry, available once the decoder is open. Frame rate comes from the stream's average
frame rate; when that's unavailable it defaults to `25/1`. Each returns `-1` for an invalid or
closed handle.

### decoder_next_frame

```c
int decoder_next_frame(int handle, uint8_t *dst_rgba, int dst_w, int dst_h);
```

Decodes the next frame, scales and converts it to RGBA8, and writes it to `dst_rgba`. Pass
`dst_w`/`dst_h` of `0` to keep the frame's native dimensions; otherwise the frame is resized with
`SWS_BILINEAR`. The buffer must hold `dst_w * dst_h * 4` bytes (or `width * height * 4` when
passing 0). The `SwsContext` is cached and rebuilt only when the source or destination geometry
changes.

Returns `0` with a frame ready, `1` at end of stream (no frame written), or a negative `AVERROR`.
The JS wrappers map the `1` return to `null`.

### decoder_next_raw_frame

```c
int decoder_next_raw_frame(int handle, uint8_t *dst, int dst_cap);
```

Decodes the next frame and copies it out in its **native** pixel format, packed at alignment 1 —
the same layout FFmpeg's rawvideo encoder and `framecrc` muxer produce, so callers can reproduce
FATE reference checksums (which `decoder_next_frame` can't, since it always converts to RGBA).

Returns the number of bytes written (> 0), `0` at end of stream, or a negative `AVERROR`
(`AVERROR(ENOMEM)` if `dst_cap` is too small for the frame). Size `dst` at `width * height * 8`
to fit any pixel format. Not wrapped by the high-level JS API; it's used by the FATE harness.

### decoder_close

```c
void decoder_close(int handle);
```

Tears down the session and frees its slot. Safe to call on an inactive handle (no-op).

## Audio decoder

An audio session resamples whatever the source is into interleaved 32-bit float at the source's
own sample rate and channel count (mono stays mono, everything else maps to stereo layout).

### audio_open

```c
int audio_open(const uint8_t *data, int size);
```

Copies and opens `data`, finds the first audio stream, opens its decoder, and configures an
`SwrContext` to produce interleaved `AV_SAMPLE_FMT_FLT`. Returns a handle (0–7) or a negative
`AVERROR` (`AVERROR_STREAM_NOT_FOUND` with no audio stream, `AVERROR_DECODER_NOT_FOUND` for a
missing codec).

### audio_open_format

```c
int audio_open_format(const uint8_t *data, int size, const char *fmt_name);
```

As above, forcing the demuxer `fmt_name`. Needed for the many game and legacy audio formats that
don't content-probe.

### audio_channels / audio_sample_rate

```c
int audio_channels(int handle);
int audio_sample_rate(int handle);
```

Channel count and sample rate of the decoded stream. The resampler preserves both, so these also
describe the output. `-1` on an invalid handle.

### audio_next_samples

```c
int audio_next_samples(int handle, float *dst_f32, int max_floats);
```

Decodes the next audio frame, resamples it to interleaved float, and writes it to `dst_f32`.
`max_floats` is the capacity of `dst_f32` measured in floats (not bytes); the function converts
at most `max_floats / channels` samples.

Returns the number of float values written — that is, `samples * channels` — or `1` at end of
stream, or a negative `AVERROR`. Pre-allocate roughly `4096 * channels` floats per call and loop
until you get `1`. (The JS wrappers translate the `1` return to `null`.)

### audio_close

```c
void audio_close(int handle);
```

Frees the audio session and its slot.

## Probe

A probe session opens the container and reads stream metadata without decoding any frames.

### probe_open

```c
int probe_open(const uint8_t *data, int size);
```

Copies and opens `data`, then runs `avformat_find_stream_info`. Returns a handle (0–7) or a
negative `AVERROR`.

### probe_format_name

```c
const char *probe_format_name(int handle);
```

The demuxer's name (for MP4 this is `"mov,mp4,m4a,3gp,3g2,mj2"`). Returns `NULL` for an invalid
handle.

### probe_duration_ms

```c
int probe_duration_ms(int handle);
```

Container duration in milliseconds, or `-1` if unknown (`AV_NOPTS_VALUE`).

### probe_stream_count

```c
int probe_stream_count(int handle);
```

Number of streams in the container, or `-1` on an invalid handle.

### probe_stream_type

```c
int probe_stream_type(int handle, int idx);
```

The `AVMediaType` of stream `idx`: `0` video, `1` audio, `2` data, `3` subtitle, `4` attachment.
Returns `-1` for an invalid handle or out-of-range index.

### probe_width / probe_height / probe_fps_num / probe_fps_den

```c
int probe_width(int handle);
int probe_height(int handle);
int probe_fps_num(int handle);
int probe_fps_den(int handle);
```

Geometry of the **first video stream**. Frame-rate accessors return `-1` when the stream reports
no average frame rate. All return `-1` if there's no video stream.

### probe_sample_rate / probe_channels

```c
int probe_sample_rate(int handle);
int probe_channels(int handle);
```

Sample rate and channel count of the **first audio stream**, or `-1` if there's no audio stream.

### probe_bitrate

```c
int probe_bitrate(int handle);
```

Overall container bitrate in **kb/s** (the raw bit/s value divided by 1000), or `-1` on an
invalid handle.

### probe_close

```c
void probe_close(int handle);
```

Frees the probe session and its slot.

## Encoder

An encoder session muxes one video stream into a growable in-memory buffer. RGBA frames are
converted with `SwsContext` into the encoder's first supported pixel format.

### encoder_open

```c
int encoder_open(const char *fmt_name, const char *codec_name,
                 int width, int height, int fps_num, int fps_den, int bitrate);
```

| Param | Meaning |
|-------|---------|
| `fmt_name` | Container/muxer name, e.g. `"image2pipe"`, `"mp4"`, `"webm"`, `"wav"`. |
| `codec_name` | Encoder name, looked up with `avcodec_find_encoder_by_name`, e.g. `"mjpeg"`, `"png"`. |
| `width`, `height` | Frame dimensions in pixels (`0` for audio-only muxers). |
| `fps_num`, `fps_den` | Frame rate, used for the codec time base and frame rate. |
| `bitrate` | Target bitrate in bits/s; `0` leaves the codec default. |

Opens the muxer over an in-memory writable IO context, picks the codec's first supported pixel
format (falling back to `yuv420p`), sets up RGBA→pix_fmt conversion, and writes the container
header. Returns a handle (0–3) or a negative `AVERROR`: `AVERROR(ENOMEM)` if all four slots are
busy, `AVERROR_ENCODER_NOT_FOUND` for an unknown codec name, or a muxer error for an unknown
format.

### encoder_push_rgba

```c
int encoder_push_rgba(int handle, const uint8_t *rgba, int w, int h, int pts_ms);
```

Converts one RGBA8 frame to the encoder's pixel format, sets its presentation timestamp from
`pts_ms` (rescaled from milliseconds into the codec time base), encodes it, and writes any
resulting packets. `w`/`h` describe the incoming frame's stride. Returns `0` on success or a
negative `AVERROR`.

### encoder_finish

```c
int encoder_finish(int handle);
```

Flushes the encoder (drains buffered packets) and writes the container trailer. Call once, after
the last `encoder_push_rgba`. Returns `0` on success or a negative `AVERROR`. After this, read the
output with the two accessors below.

### encoder_output_ptr / encoder_output_size

```c
uint8_t *encoder_output_ptr(int handle);
int      encoder_output_size(int handle);
```

A pointer to the muxed bytes and their length. Valid after `encoder_finish` and until
`encoder_close`. `encoder_output_ptr` returns `NULL` and `encoder_output_size` returns `-1` on an
invalid handle. **Copy the bytes out before closing** — the buffer is freed on close, and any
later allocation can move or reuse the heap region:

```js
const ptr  = mod.ccall('encoder_output_ptr',  'number', ['number'], [h]);
const size = mod.ccall('encoder_output_size', 'number', ['number'], [h]);
const out  = new Uint8Array(mod.HEAPU8.buffer, ptr, size).slice();  // copy
```

### encoder_close

```c
void encoder_close(int handle);
```

Frees the encoder session, its output buffer, and its slot.

## Full lifecycle example

```js
// Open, pull every frame, close.
const ptr    = mod._malloc(bytes.byteLength);
mod.HEAPU8.set(bytes, ptr);
const handle = mod.ccall('decoder_open', 'number', ['number', 'number'], [ptr, bytes.byteLength]);
mod._free(ptr);
if (handle < 0) throw new Error(`open failed: ${handle}`);

const w = mod.ccall('decoder_width',  'number', ['number'], [handle]);
const h = mod.ccall('decoder_height', 'number', ['number'], [handle]);
const frameBuf = mod._malloc(w * h * 4);

for (;;) {
    const ret = mod.ccall('decoder_next_frame', 'number',
        ['number','number','number','number'], [handle, frameBuf, w, h]);
    if (ret === 1) break;                    // EOF
    if (ret < 0)   throw new Error(`decode failed: ${ret}`);
    const rgba = new Uint8ClampedArray(mod.HEAPU8.buffer, frameBuf, w * h * 4).slice();
    // … use rgba …
}

mod._free(frameBuf);
mod.ccall('decoder_close', null, ['number'], [handle]);
```

See [error codes](/docs/reference/errors/) for the negative return values. To add a new exported
function, see [configuration](/docs/build/configuration/).
