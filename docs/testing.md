# Testing

## Running the suite

```bash
# Build first — tests load dist/cpu.js directly
source ~/emsdk/emsdk_env.sh
PRESET=standard TARGET=cpu bash scripts/build.sh

node tests/test.mjs
```

Expected on a clean build:
```
Pass: 63
Fail: 0
Skip: 1
```

The one skip is the WebGPU bench test — it only runs when `dist/webgpu.js` exists. Everything else passes.

## Test structure

`tests/test.mjs` is a single file with no external framework.

```
tests/test.mjs
├─ ok(msg, cond)           assertion helper
├─ skip(msg)               expected-skip helper
├─ loadWasm()              loads dist/cpu.js, returns raw WASM module
├─ makeTinyPng(w, h)       generates a valid minimal PNG in pure JS
├─ crc32(buf)              CRC32 for PNG chunk building
├─ pngChunk(type, data)    builds a raw PNG chunk
│
├─ testBuild()             pipeline_version(), export smoke test
├─ testPipelineEdgeCases() raw C API: filtergraph errors, passthrough, bench
├─ testDecoderApi()        raw C decoder API: open, dims, frames, close, concurrency
├─ testFFmpegClass()       FFmpeg high-level class (ffmpeg.js)
├─ testGpu()               gpu namespace: load, scale, decoder, bench
└─ run()                   sequential runner, prints Pass/Fail/Skip
```

**testBuild** — loads the module, checks `pipeline_version()` returns non-zero, verifies `pipeline_run_rgba` is exported.

**testPipelineEdgeCases** — raw `pipeline_run_rgba` calls: invalid filtergraph returns negative error, same-size scale passthrough works, chained `scale,format` filtergraph works, `bench_scale_webgpu` returns -1 on CPU build.

**testDecoderApi** — raw decoder C API: garbage bytes to `decoder_open` returns error, invalid handles return -1/0, opens a valid PNG via `decoder_open_file`, checks width/height/fps, calls `decoder_next_frame` and reads RGBA from HEAPU8, calls `decoder_close`, verifies post-close guards work, two concurrent decoder slots.

**testFFmpegClass** — FFmpeg class: `load()` emits log events, double `load()` is idempotent, `on()`/`off()` work, `createDir()`/`listDir()` via WASM FS, `writeFile()`/`readFile()` round-trip, `exec()` throws with a clear message (fftools not compiled in), `terminate()` cleans up.

**testGpu** — `gpu` namespace: `load()` resolves, `hasWebGPU` is false on CPU build, double load is idempotent, `scale()` returns correct-sized RGBA, explicit filtergraph works, `benchCpu()` returns a positive number, `benchGpu()` returns -1 on CPU build, `createDecoder()` with garbage throws, `createDecoderFile()` with valid PNG works, `decoder.nextFrame()` returns pixels, `decoder.close()` doesn't throw.

## Adding a test

Find the right function, use `ok(msg, condition)`. All test functions are async.

```js
// Inside testDecoderApi():
{
    const bytes = makeTinyPng(16, 16);
    mod.FS.writeFile('/mytest.png', new Uint8Array(bytes));
    const h = mod.ccall('decoder_open_file', 'number', ['string'], ['/mytest.png']);
    ok('decoder_open_file 16x16 succeeds', h >= 0);
    const w = mod.ccall('decoder_width', 'number', ['number'], [h]);
    ok('width is 16', w === 16);
    mod.ccall('decoder_close', 'number', ['number'], [h]);
}
```

For a new C export, add it to `DECODER_EXPORTS` or `CPU_EXPORTS` in `build.sh` first, then relink. See [api.md](api.md) for ccall type mapping.

For a skip that depends on a condition:
```js
if (!someCondition) {
    skip('reason this is not testable here');
} else {
    ok('the actual assertion', someAssertion);
}
```

## What tests don't cover

**Real video/audio** — H.264, HEVC, VP9, AAC, Opus. Generating valid compressed test vectors in pure JS isn't feasible. The ffmpeg CLI isn't compiled in, so we can't transcode. PNG is the smoke test for the decoder pipeline because it can be built from scratch in pure JS. Real video tests would require committing binary fixture files.

**WebGPU scale** — needs a real GPU context. Not available in Node.js. The browser test at `tests/browser-test.html` (gitignored) covers this manually.

**Encoder pipeline** — the pipeline currently handles decode + scale only. No encoder stage yet.

**FATE tests** — FFmpeg's official test suite requires the `ffmpeg`/`ffprobe`/`ffplay` CLI tools, which aren't compiled into wasmpeg.

## Debugging failures

**Silent exit / no output** — WASM failed to load. Check `dist/cpu.js` and `dist/cpu.wasm` exist: `ls -lh dist/`

**`decoder_open_file failed: -1330794744`** — `AVERROR_PROTOCOL_NOT_FOUND`. The `file` protocol isn't compiled in. Check `grep CONFIG_FILE_PROTOCOL vendor/ffmpeg/config_components.h` — should be `1`.

**`decoder_open_file failed: -1094995529`** — `AVERROR_INVALIDDATA`. Either bad PNG data or `avio_size()` returned -1. If the PNG looks valid, check `grep CONFIG_ZLIB vendor/ffmpeg/config_components.h` — should be `1`. Missing zlib silently breaks PNG decode.

**`decoder_open_file failed: -2`** — `AVERROR(ENOENT)`. The path doesn't exist in the WASM FS. Check `mod.FS.writeFile(path, ...)` was called before `decoder_open_file`.

**"Video: png, none: unspecified size"** — `avformat_find_stream_info` opened the stream but couldn't get dimensions. Almost always `CONFIG_ZLIB 0`. Rebuild with `--enable-zlib` and `--use-port=zlib`.

**Unexpected failure count** — temporarily add per-test logging inside `ok()` to see which assertion failed:
```js
function ok(msg, cond) {
    if (!cond) console.error(`  FAIL: ${msg}`);
    // ...
}
```
