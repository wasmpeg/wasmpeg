# API Reference

## JS log subscription

The module's stdout/stderr are shared by every consumer of the loaded binary.

```js
import { gpu } from 'wasmpeg';
await gpu.load();

const unsubscribe = gpu.onLog(({ type, message }) => {
    // type is 'stdout' or 'stderr'
    console.log(`[${type}] ${message}`);
});

unsubscribe();          // or gpu.offLog(handler)
```

`FFmpeg`'s `on('log')` and `on('progress')` are built on this, so both surfaces
observe the same stream without loading a second module.

## C API

All exported functions are decorated with `EMSCRIPTEN_KEEPALIVE` and listed in `scripts/build.sh`. Source: `src/pipeline.c`.

### `pipeline_version`

```c
const char *pipeline_version(void);
```

Returns the FFmpeg version string the module was built against (`av_version_info()`),
for example `"8.0"`. In JS, read it with `ccall(..., 'string', ...)`:

```js
const version = mod.ccall('pipeline_version', 'string', [], []);
```

### `pipeline_run_rgba`

```c
int pipeline_run_rgba(
    const uint8_t *src, int src_w, int src_h,
    uint8_t *dst,       int dst_w, int dst_h,
    const char *filter
);
```

Runs an FFmpeg filtergraph on a raw RGBA8 frame. `src` and `dst` are row-major, 4 bytes per pixel. The caller allocates `dst` at `dst_w * dst_h * 4` bytes. Returns `0` on success, negative `AVERROR` on failure.

Example filtergraph strings: `"scale=1280:720"`, `"scale,format=yuv420p"`, `"crop=640:480:0:0"`.

### `pipeline_run_rgba_gpu`

Same signature as `pipeline_run_rgba`. WebGPU build only — dispatches the scale through the WebGPU backend. **Creates and destroys the WebGPU device on every call**, so its cost is dominated by device setup, not the filter itself. Returns `-1` on the CPU build.

For repeated calls at the same geometry, use a GPU session instead (below) — it pays for device creation once.

### `bench_scale_cpu` / `bench_scale_webgpu` / `bench_scale_webgpu_session`

```c
double bench_scale_cpu(int src_w, int src_h, int dst_w, int dst_h, int iters);
double bench_scale_webgpu(int src_w, int src_h, int dst_w, int dst_h, int iters);
double bench_scale_webgpu_session(int src_w, int src_h, int dst_w, int dst_h, int iters);
```

Run `iters` scale operations and return the average time in milliseconds per frame. `bench_scale_webgpu` goes through `pipeline_run_rgba_gpu` (device created per call); `bench_scale_webgpu_session` goes through a single `gpu_session_open`/`gpu_session_run` pair, so the gap between the two numbers is the per-call device-creation cost. Both return `-1` on the CPU build.

### GPU session (persistent device)

`pipeline_run_rgba_gpu` above creates a fresh WebGPU device, hardware frame pool, and filtergraph on every call — async adapter and device requests that dominate the cost of the filter work itself. A GPU session builds all three once and reuses them.

#### `gpu_session_open`

```c
int gpu_session_open(int src_w, int src_h, int dst_w, int dst_h, const char *filtergraph);
```

Opens a reusable GPU filter session at a fixed source and destination size. WebGPU build only. Returns a handle (0–3) or negative `AVERROR`; returns `-1`-range errors on the CPU build the same way `pipeline_run_rgba_gpu` does.

#### `gpu_session_run`

```c
int gpu_session_run(int handle, const uint8_t *src_rgba, uint8_t *dst_rgba);
```

Runs one frame through an open session. `src_rgba` is `src_w * src_h * 4` bytes, `dst_rgba` is `dst_w * dst_h * 4` bytes (the sizes passed to `gpu_session_open`). Returns `0` on success, negative `AVERROR` on failure.

#### `gpu_session_close`

```c
void gpu_session_close(int handle);
```

Frees the session — device, frame pool, and filtergraph. Safe to call with an invalid handle.

In JS, `gpu.createGpuSession({ srcW, srcH, dstW, dstH, filtergraph })` wraps all
three calls as `{ run(rgba), close() }`. `gpu.scale()` uses this internally,
caching one session and reusing it across calls with matching geometry.

---

### Video decoder

#### `decoder_open`

```c
int decoder_open(const uint8_t *data, int size);
```

Opens a video decoder from a byte buffer. FFmpeg probes the format automatically. Returns a session handle (0–7) or negative `AVERROR`. Works reliably for self-describing container formats: MP4, WebM, MKV, OGG.

#### `decoder_open_format`

```c
int decoder_open_format(const uint8_t *data, int size, const char *fmt_name);
```

Like `decoder_open`, but forces a specific demuxer. `fmt_name` is the **runtime** name passed to `av_find_input_format()` — not the configure flag name (see [configuration.md](configuration.md#adding-a-codec-filter-or-protocol)).

```c
int h = decoder_open_format(data, size, "png_pipe");
```

#### `decoder_open_file`

```c
int decoder_open_file(const char *path);
```

Opens a video decoder from a path in the Emscripten virtual filesystem, forcing the `image2` demuxer. Avoids the `png_pipe` "unspecified size" failure that occurs with single-frame images through the pipe demuxer. The path must already exist in the WASM FS. Requires `--enable-protocol=file`.

```js
mod.FS.writeFile('/frame.png', new Uint8Array(bytes));
const h = mod.ccall('decoder_open_file', 'number', ['string'], ['/frame.png']);
```

#### `decoder_width` / `decoder_height`

```c
int decoder_width(int handle);
int decoder_height(int handle);
```

Returns frame pixel dimensions. Returns `-1` for invalid or closed handles.

#### `decoder_fps_num` / `decoder_fps_den`

```c
int decoder_fps_num(int handle);
int decoder_fps_den(int handle);
```

Frame rate as a rational number. 29.97 fps → `fps_num=30000, fps_den=1001`. Returns `0` for invalid handles.

#### `decoder_next_frame`

```c
int decoder_next_frame(int handle, uint8_t *out_rgba, int dst_w, int dst_h);
```

Decodes the next frame, scales it to `dst_w × dst_h`, and writes RGBA8 pixels into `out_rgba`. The buffer must be pre-allocated at `dst_w * dst_h * 4` bytes. Pass `dst_w`/`dst_h` of `0` to keep the frame's native size.

Returns `0` on success, `1` at end of stream, negative `AVERROR` on error.

#### `decoder_next_raw_frame`

```c
int decoder_next_raw_frame(int handle, uint8_t *dst, int dst_cap);
```

Decodes the next frame and copies it out in its **native pixel format**, packed tightly (alignment 1) — the same byte layout FFmpeg's rawvideo encoder and `framecrc` muxer use. Unlike `decoder_next_frame`, it does no scaling or RGBA conversion, so the output can reproduce FATE reference checksums exactly (this is what `tests/fate.mjs` uses).

Returns the byte count written (`> 0`) on success, `0` at end of stream, negative `AVERROR` on error. Size `dst` at `width * height * 8` to fit any pixel format; the function returns `AVERROR(ENOMEM)` if `dst_cap` is too small.

#### `decoder_seek`

```c
int decoder_seek(int handle, int ms);
```

Seeks to `ms` milliseconds from the start of the video stream and flushes the
codec. Lands on the nearest keyframe at or before the target, so the next
`decoder_next_frame` may return a frame earlier than requested — this is a
container seek, not frame-accurate seeking.

Returns `0` on success, negative `AVERROR` on failure. In JS the decoder wrapper
exposes it as `seek(ms)`, which clamps a negative target to the start.

#### `decoder_close`

```c
void decoder_close(int handle);
```

Frees the session slot. Safe to call with an invalid handle.

#### Session slots

Up to 8 concurrent sessions (handles 0–7). `decoder_open*` returns the first free slot. Returns `AVERROR(ENOMEM)` (-12) if all slots are occupied.

---

### Audio decoder

Audio sessions share the same 8-slot pool as video decoders. Decoded output is always 32-bit float, interleaved by channel (`f32le`, planar → packed).

#### `audio_open`

```c
int audio_open(const uint8_t *data, int size);
```

Opens an audio decoder from a byte buffer. Returns a session handle (0–7) or negative `AVERROR`.

#### `audio_open_format`

```c
int audio_open_format(const uint8_t *data, int size, const char *fmt_name);
```

Like `audio_open`, but forces a specific demuxer.

#### `audio_channels` / `audio_sample_rate`

```c
int audio_channels(int handle);
int audio_sample_rate(int handle);
```

Returns the channel count and sample rate of the decoded stream. Returns `-1` for invalid handles.

#### `audio_next_samples`

```c
int audio_next_samples(int handle, float *dst_f32, int max_floats);
```

Decodes the next audio frame into `dst_f32`. The buffer must hold at least `max_floats` floats. Samples are interleaved: `[L0, R0, L1, R1, ...]`.

Returns the number of floats written on success, `1` at end of stream, negative `AVERROR` on error.

Typical usage — pre-allocate `4096 * channels` floats and loop until `1` is returned:

```js
const cap    = 4096 * channels;
const pcmBuf = mod._malloc(cap * 4); // 4 bytes per float
for (;;) {
    const n = mod.ccall('audio_next_samples', 'number',
        ['number','number','number'], [handle, pcmBuf, cap]);
    if (n === 1) break;
    if (n < 0) throw new Error(`audio_next_samples: ${n}`);
    const samples = new Float32Array(mod.HEAPU8.buffer, pcmBuf, n);
    // ... process samples
}
```

#### `audio_close`

```c
void audio_close(int handle);
```

Frees the audio session slot.

---

### Probe

Probe opens a container and reads its metadata without decoding any frames. Each `probe_open` returns a handle from the same 8-slot pool as video and audio.

#### `probe_open`

```c
int probe_open(const uint8_t *data, int size);
```

Opens a container from a byte buffer and runs `avformat_find_stream_info`. Returns a handle or negative `AVERROR`.

#### `probe_format_name`

```c
const char *probe_format_name(int handle);
```

Returns the container format name string (e.g. `"mov,mp4,m4a,3gp,3g2,mj2"`, `"matroska,webm"`). The pointer is valid until `probe_close` is called.

In JS, use `ccall` with return type `'string'`:

```js
const fmt = mod.ccall('probe_format_name', 'string', ['number'], [handle]);
```

#### `probe_duration_ms`

```c
int probe_duration_ms(int handle);
```

Returns the container duration in milliseconds. Returns `-1` if unknown.

#### `probe_stream_count`

```c
int probe_stream_count(int handle);
```

Returns the number of streams in the container.

#### `probe_stream_type`

```c
int probe_stream_type(int handle, int idx);
```

Returns the `AVMediaType` of stream `idx` as an integer: `0=video`, `1=audio`, `2=data`, `3=subtitle`, `4=attachment`. Returns `-1` for out-of-range idx.

#### Video stream accessors

```c
int probe_width(int handle);     // video stream pixel width
int probe_height(int handle);    // video stream pixel height
int probe_fps_num(int handle);   // frame rate numerator
int probe_fps_den(int handle);   // frame rate denominator
```

Returns `-1` if no video stream is present.

#### Audio stream accessors

```c
int probe_sample_rate(int handle);  // sample rate in Hz
int probe_channels(int handle);     // channel count
```

Returns `-1` if no audio stream is present.

#### `probe_bitrate`

```c
int probe_bitrate(int handle);
```

Returns the overall container bitrate in kb/s. Returns `-1` if unknown.

#### `probe_close`

```c
void probe_close(int handle);
```

Frees the probe session.

---

### Encoder

#### `encoder_open`

```c
int encoder_open(
    const char *fmt_name, const char *codec_name,
    int width, int height,
    int fps_num, int fps_den,
    int bitrate
);
```

Opens an encoder session. `fmt_name` is the muxer (e.g. `"image2"`, `"mp4"`, `"wav"`), `codec_name` is the encoder (e.g. `"mjpeg"`, `"png"`, `"aac"`). `bitrate` is in bits/s; `0` uses the codec default. Returns a handle (0–7) or negative `AVERROR`.

#### `encoder_push_rgba`

```c
int encoder_push_rgba(int handle, const uint8_t *rgba, int w, int h, int64_t pts_ms);
```

Encodes one RGBA8 frame. `pts_ms` is the presentation timestamp in milliseconds. Returns `0` on success, negative `AVERROR` on failure.

#### `encoder_finish`

```c
int encoder_finish(int handle);
```

Flushes the encoder and finalizes the container. Call once after all frames are pushed. Returns `0` on success, negative `AVERROR` on failure. After this call, the output is accessible via `encoder_output_ptr` / `encoder_output_size`.

#### `encoder_output_ptr` / `encoder_output_size`

```c
uint8_t *encoder_output_ptr(int handle);
int      encoder_output_size(int handle);
```

Returns a pointer and byte count for the encoded output buffer. Valid after `encoder_finish`, until `encoder_close` is called.

In JS, copy the output before closing:

```js
const ptr  = mod.ccall('encoder_output_ptr',  'number', ['number'], [handle]);
const size = mod.ccall('encoder_output_size', 'number', ['number'], [handle]);
const out  = new Uint8Array(mod.HEAPU8.buffer, ptr, size).slice(); // copy
```

#### `encoder_close`

```c
void encoder_close(int handle);
```

Frees the encoder session and its output buffer.

#### `encoder_open_audio`

```c
int encoder_open_audio(
    const char *fmt_name, const char *codec_name,
    int sample_rate, int channels,
    int bitrate
);
```

Opens an audio encoder session, sharing the same 4-slot pool as `encoder_open`.
`fmt_name` is the muxer (e.g. `"wav"`, `"flac"`, `"ogg"`), `codec_name` is the
encoder (e.g. `"pcm_s16le"`, `"flac"`, `"opus"`). `bitrate` is in bits/s; `0`
uses the codec default. Input is always 32-bit float, interleaved — the same
layout `audio_next_samples` produces — and is resampled internally to whatever
sample format the codec wants. Returns a handle or negative `AVERROR`.

#### `encoder_push_pcm`

```c
int encoder_push_pcm(int handle, const float *pcm, int nb_floats);
```

Pushes interleaved float samples into an audio encoder session opened with
`encoder_open_audio`. `nb_floats` is the total float count (samples ×
channels), not the frame count. Buffers internally and encodes whenever a full
codec frame has accumulated, so this can be called with any chunk size.
Returns `0` on success, negative `AVERROR` on failure.

`encoder_finish` flushes the remaining buffered samples (including a final
short frame) before finalizing the container — call it exactly as you would
for a video encoder.

---

## `gpu` namespace

```js
import { gpu } from 'wasmpeg';
```

Source: `src/js/gpu.js`.

### `gpu.load([opts])`

Loads and initializes the WASM module. Resolves a promise. Safe to call multiple times — subsequent calls resolve immediately. In a browser with WebGPU, loads `dist/webgpu.js`; otherwise loads `dist/cpu.js`. Pass `{ wasmPath }` to override.

### `gpu.hasWebGPU`

`true` if the WebGPU build is active and a GPU adapter is available. Always `false` in Node.js and on the CPU build.

### `gpu.scale(srcRgba, srcW, srcH, dstW, dstH [, filtergraph])`

```js
const out = gpu.scale(src, 1920, 1080, 1280, 720);
// out: Uint8ClampedArray, RGBA8, 1280×720×4 bytes
```

`filtergraph` is an optional FFmpeg filtergraph string. Defaults to `scale=dstW:dstH` (or `scale_webgpu=dstW:dstH` on the GPU build).

### `gpu.createDecoder(fileBytes [, fmtName])`

```js
const dec = gpu.createDecoder(new Uint8Array(mp4Bytes));
const dec = gpu.createDecoder(new Uint8Array(pngBytes), 'png_pipe');
```

Opens a video decoder from a `Uint8Array`. Throws on failure. Returns a [Decoder object](#decoder-object).

### `gpu.createDecoderFile(path)`

```js
gpu.FS.writeFile('/input.png', new Uint8Array(bytes));
const dec = gpu.createDecoderFile('/input.png');
```

Opens a video decoder from a WASM FS path. Throws on failure. Returns a [Decoder object](#decoder-object).

### Decoder object

```js
dec.width       // number — frame width in pixels
dec.height      // number — frame height in pixels
dec.fps         // number — fps_num / fps_den
dec.nextFrame([dstW, dstH])  // Uint8ClampedArray (RGBA8) | null at end of stream
dec.close()                  // void — frees the session slot
```

If `dstW`/`dstH` are omitted, `nextFrame` returns the frame at its native resolution.

### `gpu.createAudioDecoder(fileBytes [, fmtName])`

```js
const aud = gpu.createAudioDecoder(new Uint8Array(mp3Bytes));
```

Opens an audio decoder from a `Uint8Array`. Throws on failure. Returns an [AudioDecoder object](#audiodecoder-object).

### AudioDecoder object

```js
aud.channels    // number — channel count
aud.sampleRate  // number — sample rate in Hz
aud.nextSamples()  // Float32Array (interleaved f32le) | null at end of stream
aud.close()        // void — frees the session slot
```

Samples are always f32le, interleaved by channel: `[L0, R0, L1, R1, ...]`.

### `gpu.probe(fileBytes)`

```js
const info = gpu.probe(new Uint8Array(videoBytes));
```

Reads container metadata without decoding frames. Returns:

```js
{
  format:   string,        // e.g. "mov,mp4,m4a,3gp,3g2,mj2"
  duration: number|null,   // seconds, null if unknown
  bitrate:  number,        // kb/s
  streams:  [{ index: number, type: 'video'|'audio'|'data'|'subtitle'|'attachment' }],
  video:    { width, height, fpsNum, fpsDen },  // -1 fields if no video stream
  audio:    { sampleRate, channels },            // -1 fields if no audio stream
}
```

### `gpu.createEncoder(opts)`

```js
const enc = gpu.createEncoder({ fmt: 'image2', codec: 'mjpeg', width: 1280, height: 720 });
enc.pushRgba(rgbaData, 1280, 720, 0);
const output = enc.finish();  // Uint8Array
enc.close();
```

`opts`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `fmt` | string | required | Container format (e.g. `'image2'`, `'mp4'`, `'wav'`) |
| `codec` | string | required | Encoder name (e.g. `'mjpeg'`, `'png'`, `'aac'`) |
| `width` | number | `0` | Frame width in pixels (0 for audio-only) |
| `height` | number | `0` | Frame height in pixels (0 for audio-only) |
| `fps` | number \| `{num,den}` | `30` | Frame rate |
| `bitrate` | number | `0` | Target bitrate in bits/s (0 = codec default) |

Returns an [Encoder object](#encoder-object).

### Encoder object

```js
enc.pushRgba(rgba, w, h, ptsMs)  // encode one RGBA8 frame at timestamp ptsMs (ms)
enc.finish()                      // Uint8Array — finalize and return encoded bytes
enc.close()                       // void — free the session (call after finish)
```

### `gpu.benchCpu(srcW, srcH, dstW, dstH, iters)`

Returns ms/frame for CPU-based scale.

### `gpu.benchGpu(srcW, srcH, dstW, dstH, iters)`

Returns ms/frame on the WebGPU build. Returns `-1` on the CPU build.

### `gpu.FS`

The Emscripten `FS` object. Use to read/write files in the WASM virtual filesystem. `null` before `gpu.load()` resolves.

---

## `FFmpeg` class

```js
import { FFmpeg } from 'wasmpeg';
```

Source: `src/js/ffmpeg.js`. Compatible with the `@ffmpeg/ffmpeg` API shape for easier migration.

```js
const ff = new FFmpeg();
await ff.load();
```

Multiple instances share the same underlying WASM module.

### Events

```js
ff.on('log', ({ type, message }) => console.log(message));
// type: 'info' | 'warn' | 'error'

ff.on('progress', ({ progress, time }) => {});
// registered but not yet emitted — reserved for future use

ff.off('log', handler);
```

### Filesystem methods

```js
await ff.writeFile('/input.mp4', new Uint8Array(bytes));
const data = await ff.readFile('/output.png');   // Uint8Array

await ff.createDir('/frames');
const entries = await ff.listDir('/frames');     // [{ name: string, isDir: boolean }]
```

### `ff.exec(args)`

Not yet implemented — `ffmpeg`/`ffprobe` are not compiled into the WASM binary. Calling `exec()` throws with a message containing `'exec() not available'`. Use `gpu.scale()`, `gpu.createDecoder()`, `gpu.probe()`, and `gpu.createEncoder()` for media processing.

### `ff.terminate()`

Removes all event handlers and marks the instance as unloaded. Does not unload the shared WASM module.

---

## `wasmpeg` default export (high-level API)

```js
import wasmpeg from 'wasmpeg';
await wasmpeg.load();
```

Source: `src/js/wasmpeg.mjs`. Accepts any JS input type — `File`, `Blob`, `URL`, `Uint8Array`, `ArrayBuffer`, `HTMLVideoElement`, `HTMLCanvasElement`, `ImageData`. No manual buffer management.

### `wasmpeg.load([opts])`

Loads the WASM module. Delegates to `gpu.load()`.

### `wasmpeg.scale(input, dstW, dstH [, filter])`

```js
const frame = await wasmpeg.scale(file, 1280, 720);
```

Returns a `Uint8ClampedArray` of RGBA8 pixels. `filter` is an optional FFmpeg filtergraph string.

### `wasmpeg.decode(input [, { format }])`

```js
const dec = await wasmpeg.decode(file);
```

Opens a video decoder. Returns a [Decoder object](#decoder-object). `format` forces a specific demuxer.

### `wasmpeg.decodeAudio(input [, { format }])`

```js
const aud = await wasmpeg.decodeAudio(file);
```

Opens an audio decoder. Returns an [AudioDecoder object](#audiodecoder-object).

### `wasmpeg.probe(input)`

```js
const info = await wasmpeg.probe(file);
// info.format, info.duration, info.streams, info.video, info.audio
```

Returns the same structure as [`gpu.probe()`](#gpuprobebytes).

### `wasmpeg.encode(input, opts)`

```js
// Single-frame JPEG thumbnail at 320×240:
const jpgBytes = await wasmpeg.encode(file, { fmt: 'image2', codec: 'mjpeg', width: 320, height: 240 });
```

Decodes `input` frame-by-frame, encodes each frame with the specified encoder, and returns the container bytes as a `Uint8Array`.

`opts`: `fmt`, `codec`, `width`, `height`, `fps`, `bitrate`, `frames` (max frames to encode, default all), `format` (force input demuxer).

### `wasmpeg.encodeAudio(input, opts)`

```js
const flac = await wasmpeg.encodeAudio(file, { fmt: 'flac', codec: 'flac' });
```

Decodes the audio of `input`, re-encodes it, and returns the container bytes.
Sample rate and channel count are taken from the source; there is no resample
option beyond what the target codec forces.

`opts`: `fmt` (default `'wav'`), `codec` (default `'pcm_s16le'`), `bitrate` (bits/s, `0` = codec default), `format` (force input demuxer).

### `wasmpeg.run(input, args)`

Low-level: passes `args` (FFmpeg-style flag array) directly to `exec()`. For advanced filtergraph use.

### Transcoding through `exec()` / `FFmpeg.exec()`

Naming an output file routes to an encoder instead of returning raw pixels or a
decoder, and the result is written into the WASM FS at that path:

```js
await ff.writeFile('in.mp4', data);
await ff.exec(['-i', 'in.mp4', 'out.gif']);
const gif = await ff.readFile('out.gif');   // also returned directly by exec()
```

The output extension picks both muxer and codec from a fixed table in
`src/js/formats.js` (`OUT_FMT`) — there is no `-c:v`/`-c:a` override yet, and an
unlisted extension throws rather than silently failing:

| Extension | Container | Codec |
|-----------|-----------|-------|
| `.gif` | gif | gif |
| `.png` | image2pipe | png |
| `.jpg`, `.jpeg` | image2pipe | mjpeg |
| `.bmp` | image2pipe | bmp |
| `.tif`, `.tiff` | image2pipe | tiff |
| `.tga` | image2pipe | targa |
| `.dpx` | image2pipe | dpx |
| `.avi` | avi | ffv1 (lossless) |
| `.mkv` | matroska | ffv1 (lossless) |
| `.wav` | wav | pcm_s16le |
| `.flac` | flac | flac |
| `.ogg`, `.opus` | ogg | opus |

There is no H.264/HEVC/VP8/VP9/AV1 encoder in the LGPL build, so `.mp4` and
`.webm` are deliberately absent — naming one throws
`no encoder for .mp4 in this build` rather than producing a container the
decoder side can't fill. `-vf`/`-s` set the output geometry, `-vframes` caps
frame count, and audio-typed extensions (`.wav`/`.flac`/`.ogg`/`.opus`) route
through the audio decoder/encoder pair instead of the video path.

---

## Memory management

Buffers cross the JS/WASM boundary through Emscripten's heap (`HEAPU8`). The `gpu` and `FFmpeg` wrappers handle this automatically. When calling C functions directly:

```js
const ptr = mod._malloc(bytes.byteLength);
mod.HEAPU8.set(bytes, ptr);
const result = mod.ccall('my_fn', 'number', ['number', 'number'], [ptr, bytes.byteLength]);
mod._free(ptr);
```

## Error codes

| Value | Name | Meaning |
|-------|------|---------|
| `-1` | — | Invalid handle or NULL pointer |
| `-2` | `AVERROR(ENOENT)` | Path not found in WASM FS |
| `-12` | `AVERROR(ENOMEM)` | Session pool full — 8 decode/audio/probe slots, 4 encoder slots, 4 GPU session slots, each pool independent |
| `-1094995529` | `AVERROR_INVALIDDATA` | Corrupt data or zlib missing |
| `-1330794744` | `AVERROR_PROTOCOL_NOT_FOUND` | `file` protocol not compiled in |
| `-1163346256` | `AVERROR_DECODER_NOT_FOUND` | Decoder not compiled in |
| `-1414092869` | `AVERROR_ENCODER_NOT_FOUND` | Encoder not compiled in |
| `-541478725` | `AVERROR_MUXER_NOT_FOUND` | Muxer not compiled in |

In C, `av_strerror(ret, buf, sizeof(buf))` converts any code to a human-readable string.
