# API Reference

## C API (`src/pipeline.c`)

All exported functions have `EMSCRIPTEN_KEEPALIVE` and are listed in `EXPORTED_FUNCTIONS` in `scripts/build.sh`.

### pipeline_version

```c
int pipeline_version(void);
```

Returns the pipeline ABI version (currently 1).

### pipeline_run_rgba

```c
int pipeline_run_rgba(
    const uint8_t *src,   // RGBA8 input, row-major
    int src_w, int src_h,
    uint8_t *dst,         // output buffer — caller allocates dst_w * dst_h * 4 bytes
    int dst_w, int dst_h,
    const char *filter    // filtergraph, e.g. "scale=320:240" or "scale,format=yuv420p"
);
```

Runs an FFmpeg filtergraph on raw RGBA input. Returns 0 on success, negative AVERROR on failure.

Filters in the standard preset: `scale`, `crop`, `overlay`, `format`, `transpose`, `rotate`, `pad`, `trim`, `setpts`, `fps`, `split`, `drawtext`, `colorspace`, `hstack`, `vstack`, `aresample`.

### pipeline_run_rgba_gpu

```c
int pipeline_run_rgba_gpu(
    const uint8_t *src,
    int src_w, int src_h,
    uint8_t *dst,
    int dst_w, int dst_h,
    const char *filter
);
```

WebGPU build only. Same signature as `pipeline_run_rgba` but dispatches scale through the WebGPU backend. Returns -1 on CPU build.

### bench_scale_cpu

```c
float bench_scale_cpu(int src_w, int src_h, int dst_w, int dst_h, int iters);
```

Benchmarks `pipeline_run_rgba` scale over `iters` iterations. Returns ms/frame.

### bench_scale_webgpu

```c
float bench_scale_webgpu(int src_w, int src_h, int dst_w, int dst_h, int iters);
```

WebGPU build only. Returns -1 on CPU build.

### decoder_open

```c
int decoder_open(const uint8_t *data, int size);
```

Opens a decoder from a byte buffer. FFmpeg probes the format automatically. Returns a slot handle (0–7) or negative AVERROR.

Works well for: MP4, WebM, MKV, OGG — containers that probe cleanly from a buffer.

### decoder_open_format

```c
int decoder_open_format(const uint8_t *data, int size, const char *fmt_name);
```

Same as `decoder_open` but forces a specific demuxer. `fmt_name` is passed to `av_find_input_format()` — use the runtime name, not the configure flag name (see the table in [configuration.md](configuration.md)).

Example: `decoder_open_format(data, size, "png_pipe")`

### decoder_open_file

```c
int decoder_open_file(const char *path);
```

Opens a decoder from a path in the Emscripten virtual filesystem. Forces the `image2` demuxer to avoid the `png_pipe` "unspecified size" failure on single-frame images.

The path must exist in the WASM FS — write it first with `mod.FS.writeFile(path, data)`.

Requires `--enable-protocol=file` (in standard preset). Without it, returns `AVERROR_PROTOCOL_NOT_FOUND`.

### decoder_width / decoder_height

```c
int decoder_width(int handle);
int decoder_height(int handle);
```

Returns pixel dimensions. Returns -1 for invalid or closed handles.

### decoder_fps_num / decoder_fps_den

```c
int decoder_fps_num(int handle);
int decoder_fps_den(int handle);
```

Frame rate as a rational. 30fps → `fps_num=30, fps_den=1`. 29.97fps → `fps_num=30000, fps_den=1001`. Returns 0 for invalid handles.

### decoder_next_frame

```c
int decoder_next_frame(int handle, uint8_t *out_rgba);
```

Decodes the next frame into `out_rgba`. The buffer must be pre-allocated at `width * height * 4` bytes. Output is always RGBA8, row-major, top-to-bottom.

Returns `1` on success, `0` at end of stream, negative AVERROR on error.

### decoder_close

```c
int decoder_close(int handle);
```

Frees the slot. Calling with an invalid handle returns -1 without crashing.

### Slots

Up to 8 concurrent decoder sessions (handles 0–7). `decoder_open*` returns the first free slot. Returns `AVERROR(ENOMEM)` if all are in use.

---

## JS API — `gpu` namespace

```js
import { gpu } from 'wasmpeg';
```

### gpu.load()

```js
await gpu.load();
```

Loads the WASM module. Idempotent — safe to call multiple times.

### gpu.hasWebGPU

`true` if the WebGPU build is loaded and a GPU adapter was found. Always `false` on Node.js and on the CPU build.

### gpu.scale(srcRgba, srcW, srcH, dstW, dstH, filter?)

```js
const output = await gpu.scale(
    srcRgba,         // Uint8Array, RGBA8
    srcW, srcH,
    dstW, dstH,
    'scale=320:240'  // optional filtergraph (default: scale to dstW:dstH)
);
// → Uint8Array, RGBA8, dstW * dstH * 4 bytes
```

### gpu.createDecoder(fileBytes, fmtName?)

```js
const dec = gpu.createDecoder(fileBytes, 'png_pipe');  // fmtName optional
```

Opens a decoder from a `Uint8Array`. Throws on failure. Returns a `Decoder` object.

### gpu.createDecoderFile(path)

```js
gpu.FS.writeFile('/input.png', new Uint8Array(bytes));
const dec = gpu.createDecoderFile('/input.png');
```

Opens a decoder from a WASM FS path. Throws on failure. Returns a `Decoder` object.

### Decoder object

```js
dec.width       // number
dec.height      // number
dec.fps         // number (fps_num / fps_den)
dec.nextFrame() // Uint8Array (RGBA8) | null at end of stream
dec.close()     // void
```

### gpu.benchCpu(srcW, srcH, dstW, dstH, iters)

Returns ms/frame for CPU scale.

### gpu.benchGpu(srcW, srcH, dstW, dstH, iters)

Returns ms/frame on WebGPU build. Returns -1 on CPU build.

### gpu.FS

```js
gpu.FS.writeFile('/path', data);  // Uint8Array
gpu.FS.readFile('/path');         // Uint8Array
gpu.FS.unlink('/path');
```

The Emscripten `FS` object. `null` before `gpu.load()` is called.

---

## JS API — FFmpeg class

```js
import { FFmpeg } from 'wasmpeg';

const ff = new FFmpeg();
await ff.load();
```

Compatible with the `@ffmpeg/ffmpeg` API shape. Multiple instances share the same underlying WASM module.

### Events

```js
ff.on('log', ({ type, message }) => console.log(message));
// type: 'info' | 'warn' | 'error'

ff.on('progress', ({ progress, time }) => {});
// progress event is registered but not yet emitted

ff.off('log', handler);
```

### Filesystem

```js
await ff.writeFile('/input.mp4', new Uint8Array(bytes));
const data = await ff.readFile('/output.png');  // Uint8Array
await ff.createDir('/frames');
const entries = await ff.listDir('/frames');    // [{ name, isDir }]
```

### ff.exec(args)

Not yet implemented — the `ffmpeg`/`ffprobe` CLI tools are not compiled into the WASM binary. Calling `exec()` throws with a message containing `'exec() not available'`. This is intentional: apps migrating from `@ffmpeg/ffmpeg` get a clear error rather than a silent hang. Use `gpu.scale()` and `gpu.createDecoder()` instead.

### ff.terminate()

Removes all event handlers and marks the instance unloaded. Does not unload the shared WASM module.

---

## Memory

Buffers cross the JS↔WASM boundary through Emscripten's heap (`HEAPU8`). The `gpu` and `FFmpeg` wrappers handle this automatically. If you're calling C functions directly:

```js
const ptr = mod._malloc(bytes.byteLength);
mod.HEAPU8.set(bytes, ptr);
const result = mod.ccall('my_fn', 'number', ['number', 'number'], [ptr, bytes.byteLength]);
mod._free(ptr);
```

## Error codes

| Value | Name | Meaning |
|-------|------|---------|
| `-1` | — | Invalid handle (guard check) |
| `-2` | `AVERROR(ENOENT)` | Path not found in WASM FS |
| `-12` | `AVERROR(ENOMEM)` | All 8 decoder slots in use |
| `-1094995529` | `AVERROR_INVALIDDATA` | Corrupt data, or zlib missing (`CONFIG_ZLIB 0`) |
| `-1330794744` | `AVERROR_PROTOCOL_NOT_FOUND` | `file` protocol not compiled in |
| `-1163346256` | `AVERROR_DECODER_NOT_FOUND` | Decoder not compiled in |

In C: `av_strerror(ret, buf, sizeof(buf))` gives a human-readable string. There's no JS equivalent without exporting `av_strerror` as a C export.
