# Configuration

All codec, filter, protocol, and format decisions live in `src/cli/configure.mjs`. It generates `configure-cpu.sh` (and `configure-webgpu.sh`), which `scripts/build.sh` then runs. Never edit those generated scripts directly — they're overwritten on every build.

## Presets

wasmpeg ships two presets:

**`minimal`** — H.264/VP8 decode, AAC/MJPEG/PNG encode, basic filters. Smallest useful build.

**`standard`** (default) — full decode suite (H.264, HEVC, VP8/9, AV1, AAC, Opus, MP3, Vorbis, PNG, MJPEG, GIF, FLAC), common native encoders, all pipeline filters.

To add a preset, add an entry to the `PRESETS` object in `configure.mjs`:

```js
custom: {
    decoders:  ['h264', 'vp9', 'aac', 'opus'],
    encoders:  ['aac'],
    demuxers:  ['mov', 'mp4', 'matroska', 'image2', 'image2pipe', 'image_png_pipe'],
    muxers:    ['mp4', 'null'],
    parsers:   ['h264', 'vp9', 'aac', 'opus', 'png'],
    protocols: ['file'],
    filters:   ['scale', 'format'],
},
```

Build it with `PRESET=custom TARGET=cpu bash scripts/build.sh`.

## Adding a codec, filter, or protocol

First, find the exact component name FFmpeg expects. The vendored source is the authoritative list:

```bash
cd vendor/ffmpeg
./configure --list-decoders
./configure --list-encoders
./configure --list-demuxers
./configure --list-muxers
./configure --list-filters
./configure --list-protocols
```

Add the name to the appropriate list in your preset:

```js
decoders:  [..., 'av1'],
demuxers:  [..., 'image_png_pipe'],
protocols: [..., 'file'],
filters:   [..., 'drawtext'],
```

After rebuilding, verify it compiled:

```bash
grep CONFIG_AV1_DECODER vendor/ffmpeg/config_components.h
# expect: #define CONFIG_AV1_DECODER 1
```

> **Note:** Image pipe demuxers have a naming split that will bite you. The `--enable-demuxer=` flag uses the configure name; `av_find_input_format()` at runtime uses a different name:
>
> | Format | `--enable-demuxer=` | Runtime name |
> |--------|---------------------|--------------|
> | PNG pipe | `image_png_pipe` | `png_pipe` |
> | JPEG pipe | `image_jpeg_pipe` | `jpeg_pipe` |
> | File images | `image2` | `image2` |
>
> Using `--enable-demuxer=png_pipe` sets nothing (`CONFIG_IMAGE_PNG_PIPE_DEMUXER` stays 0) and produces no error — it silently fails at runtime.

## External library dependencies

Some codecs require an external library. For Emscripten builds these come from Emscripten ports.

| Library | FFmpeg flag | emcc flag | Used by |
|---------|-------------|-----------|---------|
| zlib | `--enable-zlib` | `--use-port=zlib` | PNG decode, FLAC, MKV compression |
| libpng | `--enable-libpng` | `--use-port=libpng` | Alternative PNG encoder |

**zlib is required for PNG decode.** Without it, `avformat_find_stream_info` opens the stream but can't determine frame dimensions, and `avcodec_receive_frame` returns nothing. There's no compile-time error — it fails silently at runtime.

To wire up zlib (already done in the standard preset):

1. In `configure.mjs`, add `'--enable-zlib'` to the flags array and `'-lz'` to `extraLdflags`.
2. In `scripts/build.sh`, add `--use-port=zlib` to the CPU emcc link command.
3. Pre-seed the port cache once: `emcc --use-port=zlib -o /dev/null /dev/null 2>/dev/null`

## SIMD

`-msimd128` (WebAssembly SIMD128) is enabled in CPU builds. It accelerates `libswscale` inner loops by roughly 2× with zero impact on binary size. Browser support: Chrome 91+, Firefox 89+, Safari 16.4+.

To disable it for a legacy build, remove `-msimd128` from `extraCflags` in `configure.mjs` and from the CPU link step in `scripts/build.sh`.

## Exporting a new C function

1. Add `EMSCRIPTEN_KEEPALIVE` to the function in `src/pipeline.c`.
2. Add `_function_name` to `DECODER_EXPORTS` or `CPU_EXPORTS` in `scripts/build.sh`.
3. Relink — no FFmpeg rebuild needed. See the incremental relink command in [building.md](building.md#incremental-rebuilds).
4. Call from JS: `mod.ccall('function_name', returnType, argTypes, args)`

`ccall` type strings: `'number'` for int/float/pointer, `'string'` for `const char *`, `null` for void.

## Upgrading FFmpeg

```bash
cd vendor/ffmpeg
git fetch origin
git checkout n8.x.x
cd ../..
source ~/emsdk/emsdk_env.sh
node src/cli/configure.mjs --preset=standard --target=cpu
bash configure-cpu.sh
cd vendor/ffmpeg && emmake make distclean && emmake make -j$(nproc) install
```

After a major version bump, re-run `./configure --list-demuxers` and similar to check for renamed components, then run the full test suite.

## WebGPU build

The WebGPU build adds `pipeline_run_rgba_gpu` and `bench_scale_webgpu`. It requires three additions vs the CPU build:

- `--use-port=emdawnwebgpu` in both configure cflags and the emcc link
- `-s ASYNCIFY` in the emcc link
- `-DCONFIG_WEBGPU` in the emcc link

`TARGET=webgpu bash scripts/build.sh` handles all of this. Node.js has no WebGPU adapter, so GPU functions return -1 in tests — this is expected.
