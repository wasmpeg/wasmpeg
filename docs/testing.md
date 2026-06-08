# Testing

## Running the suite

Build first, then run:

```bash
source ~/emsdk/emsdk_env.sh
PRESET=standard TARGET=cpu bash scripts/build.sh
node tests/test.mjs
```

A clean build produces:

```
Pass: 63
Fail: 0
Skip: 1
```

The skip is the WebGPU bench test — it only runs when `dist/webgpu.js` is present.

## Test layout

`tests/test.mjs` is a single file with no external framework. It has four test groups, each exercising a different layer of the stack:

**`testBuild`** — sanity checks that the WASM module loaded correctly: `pipeline_version()` returns a non-zero integer and `pipeline_run_rgba` is exported.

**`testPipelineEdgeCases`** — calls `pipeline_run_rgba` directly with various filtergraph strings: an invalid graph returns a negative error code, a same-size passthrough produces correct output, and a chained `scale,format` graph works end to end.

**`testDecoderApi`** — exercises the raw C decoder API. Covers garbage input rejection, invalid-handle guards, opening a PNG via `decoder_open_file`, reading frame dimensions and fps, decoding a frame and checking RGBA output, post-close guards, and two concurrent decoder slots.

**`testFFmpegClass`** — exercises the high-level `FFmpeg` class: load, double-load idempotency, `on()`/`off()` events, `createDir`/`listDir`, `writeFile`/`readFile` round-trip, the `exec()` not-available error, and `terminate()`.

**`testGpu`** — exercises the `gpu` namespace: load, scale, explicit filtergraph, `benchCpu`, `benchGpu` (returns -1 on CPU build), `createDecoder` error path, and `createDecoderFile` success path.

## Adding a test

Find the appropriate group and use the `ok(msg, condition)` helper. All test functions are async.

```js
// Inside testDecoderApi():
{
    const bytes = makeTinyPng(16, 16);
    mod.FS.writeFile('/test.png', new Uint8Array(bytes));
    const h = mod.ccall('decoder_open_file', 'number', ['string'], ['/test.png']);
    ok('open 16×16 PNG', h >= 0);
    ok('width is 16', mod.ccall('decoder_width', 'number', ['number'], [h]) === 16);
    mod.ccall('decoder_close', null, ['number'], [h]);
}
```

If a test only makes sense under a specific condition, use `skip()`:

```js
if (!someCondition) {
    skip('reason this cannot run here');
} else {
    ok('the assertion', result === expected);
}
```

When adding a new C export, add it to `DECODER_EXPORTS` or `CPU_EXPORTS` in `scripts/build.sh` and relink before testing. See the [API reference](api.md#c-api) for `ccall` type mappings.

## What isn't tested

**Real video and audio** — H.264, HEVC, VP9, AAC, Opus. Generating valid compressed test vectors in pure JS isn't practical, and the `ffmpeg` CLI isn't compiled into the WASM binary. PNG covers the decoder pipeline because it can be constructed from scratch in pure JS. Real video tests would require shipping binary fixture files.

**WebGPU scale** — requires a live GPU context, which Node.js doesn't provide. This is tested manually in a browser.

**Encoder pipeline** — the pipeline currently handles decode and scale only; there's no encoder stage yet.

## Debugging failures

**Silent exit** — the WASM module failed to load. Verify `dist/cpu.js` and `dist/cpu.wasm` both exist.

**`decoder_open_file failed: -1330794744`** — `AVERROR_PROTOCOL_NOT_FOUND`. The `file` protocol wasn't compiled in. Check:
```bash
grep CONFIG_FILE_PROTOCOL vendor/ffmpeg/config_components.h
```
Should be `1`. If it's `0`, add `file` to the `protocols` list in `configure.mjs` and rebuild.

**`decoder_open_file failed: -1094995529`** — `AVERROR_INVALIDDATA`. Either the input is malformed, or zlib is missing and PNG IDAT decompression is silently failing. Check:
```bash
grep CONFIG_ZLIB vendor/ffmpeg/config_components.h
```
Should be `1`. If it's `0`, see [configuration.md](configuration.md#external-library-dependencies).

**`decoder_open_file failed: -2`** — `AVERROR(ENOENT)`. The path doesn't exist in the WASM virtual filesystem. Make sure `mod.FS.writeFile(path, data)` ran before the open call.

**"Video: png, none: unspecified size"** — `avformat_find_stream_info` opened the stream but couldn't determine frame dimensions. Almost always `CONFIG_ZLIB 0` — see above.
