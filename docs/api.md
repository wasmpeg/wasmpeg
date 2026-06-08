# API Reference

## C API

All exported functions are decorated with `EMSCRIPTEN_KEEPALIVE` and listed in `EXPORTED_FUNCTIONS` in `scripts/build.sh`. Source: `src/pipeline.c`.

### `pipeline_version`

```c
int pipeline_version(void);
```

Returns the pipeline ABI version (currently `1`).

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

Available filters (standard preset): `scale`, `crop`, `overlay`, `format`, `transpose`, `rotate`, `pad`, `trim`, `setpts`, `fps`, `split`, `colorspace`, `hstack`, `vstack`, `aresample`.

### `pipeline_run_rgba_gpu`

Same signature as `pipeline_run_rgba`. WebGPU build only — dispatches the scale through the WebGPU backend. Returns `-1` on the CPU build.

### `bench_scale_cpu` / `bench_scale_webgpu`

```c
float bench_scale_cpu(int src_w, int src_h, int dst_w, int dst_h, int iters);
float bench_scale_webgpu(int src_w, int src_h, int dst_w, int dst_h, int iters);
```

Run `iters` scale operations and return the average time in milliseconds per frame. `bench_scale_webgpu` returns `-1` on the CPU build.

### `decoder_open`

```c
int decoder_open(const uint8_t *data, int size);
```

Opens a decoder from a byte buffer. FFmpeg probes the format automatically. Returns a session handle (0–7) or negative `AVERROR`.

Works reliably for self-describing container formats: MP4, WebM, MKV, OGG.

### `decoder_open_format`

```c
int decoder_open_format(const uint8_t *data, int size, const char *fmt_name);
```

Like `decoder_open`, but forces a specific demuxer. `fmt_name` is passed to `av_find_input_format()` — use the **runtime** name, not the configure flag name (see the table in [configuration.md](configuration.md#adding-a-codec-filter-or-protocol)).

```c
// Open a PNG from a buffer
int h = decoder_open_format(data, size, "png_pipe");
```

### `decoder_open_file`

```c
int decoder_open_file(const char *path);
```

Opens a decoder from a path in the Emscripten virtual filesystem, forcing the `image2` demuxer. This avoids the `png_pipe` "unspecified size" failure that occurs when opening single-frame images through the pipe demuxer.

The path must already exist in the WASM FS. Write it first:

```js
mod.FS.writeFile('/frame.png', new Uint8Array(bytes));
const h = mod.ccall('decoder_open_file', 'number', ['string'], ['/frame.png']);
```

Requires `--enable-protocol=file`. Returns `AVERROR_PROTOCOL_NOT_FOUND` (-1330794744) if the protocol wasn't compiled in.

### `decoder_width` / `decoder_height`

```c
int decoder_width(int handle);
int decoder_height(int handle);
```

Returns the pixel dimensions of the decoded stream. Returns `-1` for invalid or closed handles.

### `decoder_fps_num` / `decoder_fps_den`

```c
int decoder_fps_num(int handle);
int decoder_fps_den(int handle);
```

Frame rate as a rational number. A 30 fps stream returns `fps_num=30, fps_den=1`. A 29.97 fps stream returns `fps_num=30000, fps_den=1001`. Returns `0` for invalid handles.

### `decoder_next_frame`

```c
int decoder_next_frame(int handle, uint8_t *out_rgba);
```

Decodes the next frame into `out_rgba`. The buffer must be pre-allocated at `width * height * 4` bytes. Output is RGBA8, row-major, top-to-bottom.

Returns `1` on success, `0` at end of stream, negative `AVERROR` on error.

### `decoder_close`

```c
int decoder_close(int handle);
```

Frees the session slot and all associated resources. Safe to call with an invalid handle (returns `-1` without crashing).

### Session slots

Up to 8 concurrent sessions (handles 0–7). `decoder_open*` returns the first free slot. Returns `AVERROR(ENOMEM)` (-12) if all slots are occupied.

---

## `gpu` namespace

```js
import { gpu } from 'wasmpeg';
```

Source: `src/js/gpu.js`.

### `gpu.load()`

Loads and initializes the WASM module. Returns a promise. Safe to call multiple times — subsequent calls resolve immediately.

### `gpu.hasWebGPU`

`true` if the WebGPU build is active and a GPU adapter is available. Always `false` in Node.js and on the CPU build.

### `gpu.scale(srcRgba, srcW, srcH, dstW, dstH [, filter])`

```js
const out = await gpu.scale(src, 1920, 1080, 1280, 720);
// out: Uint8Array, RGBA8, 1280 × 720 × 4 bytes
```

`filter` is an optional FFmpeg filtergraph string. Defaults to `scale=dstW:dstH`.

### `gpu.createDecoder(fileBytes [, fmtName])`

```js
const dec = gpu.createDecoder(new Uint8Array(mp4Bytes));
const dec = gpu.createDecoder(new Uint8Array(pngBytes), 'png_pipe');
```

Opens a decoder from a `Uint8Array`. Throws on failure. Returns a `Decoder` object.

### `gpu.createDecoderFile(path)`

```js
gpu.FS.writeFile('/input.png', new Uint8Array(bytes));
const dec = gpu.createDecoderFile('/input.png');
```

Opens a decoder from a WASM FS path. Throws on failure. Returns a `Decoder` object.

### Decoder object

```js
dec.width       // number — frame width in pixels
dec.height      // number — frame height in pixels
dec.fps         // number — fps_num / fps_den
dec.nextFrame() // Uint8ClampedArray (RGBA8) | null at end of stream
dec.close()     // void — frees the session slot
```

### `gpu.benchCpu(srcW, srcH, dstW, dstH, iters)`

Returns ms/frame for CPU-based scale.

### `gpu.benchGpu(srcW, srcH, dstW, dstH, iters)`

Returns ms/frame on the WebGPU build. Returns `-1` on the CPU build.

### `gpu.FS`

The Emscripten `FS` object. Use it to read and write files in the WASM virtual filesystem before passing paths to `createDecoderFile`. `null` before `gpu.load()` resolves.

---

## `FFmpeg` class

```js
import { FFmpeg } from 'wasmpeg';
```

Source: `src/js/ffmpeg.js`. Compatible with the `@ffmpeg/ffmpeg` API shape.

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
// registered but not yet emitted

ff.off('log', handler);
```

### Filesystem methods

```js
await ff.writeFile('/input.mp4', new Uint8Array(bytes));
const data = await ff.readFile('/output.png');  // Uint8Array

await ff.createDir('/frames');
const entries = await ff.listDir('/frames');    // [{ name: string, isDir: boolean }]
```

### `ff.exec(args)`

Not yet implemented — `ffmpeg`/`ffprobe` are not compiled into the WASM binary. Calling `exec()` throws with a message containing `'exec() not available'`, so apps migrating from `@ffmpeg/ffmpeg` get a clear error rather than a silent hang. Use `gpu.scale()` and `gpu.createDecoder()` for media processing.

### `ff.terminate()`

Removes all event handlers and marks the instance as unloaded. Does not unload the shared WASM module.

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
| `-1` | — | Invalid handle |
| `-2` | `AVERROR(ENOENT)` | Path not found in WASM FS |
| `-12` | `AVERROR(ENOMEM)` | All 8 decoder slots in use |
| `-1094995529` | `AVERROR_INVALIDDATA` | Corrupt data or zlib missing |
| `-1330794744` | `AVERROR_PROTOCOL_NOT_FOUND` | `file` protocol not compiled in |
| `-1163346256` | `AVERROR_DECODER_NOT_FOUND` | Decoder not compiled in |

In C, `av_strerror(ret, buf, sizeof(buf))` converts a code to a human-readable string.
