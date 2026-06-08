# Configuration

`src/cli/configure.mjs` is where all codec, filter, protocol, and format decisions live. It generates `configure-cpu.sh` (and `configure-webgpu.sh`) which are then run by `scripts/build.sh`. Never edit those generated scripts directly — they're overwritten on every build.

## Presets

Two presets ship today:

**`minimal`** — H.264/VP8 decode, AAC/MJPEG/PNG encode, basic filters. Smallest useful build.

**`standard`** (default) — Full decode suite (H.264, HEVC, VP8/9, AV1, AAC, Opus, MP3, Vorbis, PNG, MJPEG, GIF, FLAC), common native encoders, all pipeline filters.

To add a preset, add an entry to the `PRESETS` object in `configure.mjs`:

```js
custom: {
    decoders:  ['h264', 'vp9', 'aac', 'opus'],
    encoders:  ['aac'],
    demuxers:  ['mov', 'mp4', 'matroska', 'image2', 'image2pipe', 'image_png_pipe'],
    muxers:    ['mp4', 'null'],
    parsers:   ['h264', 'vp9', 'aac', 'opus', 'png'],
    protocols: ['file'],
    filters:   ['buffer', 'buffersink', 'scale', 'format'],
},
```

Then build: `PRESET=custom TARGET=cpu bash scripts/build.sh`

## Adding codecs, formats, and filters

### Finding the right name

FFmpeg's `--enable-*` flags use the component's internal name. Get the full list from the vendored source:

```bash
cd vendor/ffmpeg
./configure --list-decoders
./configure --list-encoders
./configure --list-demuxers
./configure --list-muxers
./configure --list-filters
./configure --list-protocols
```

**Gotcha with image demuxers** — the configure flag name and the runtime name are different for image pipes:

| Format | `--enable-demuxer=` | Runtime name (for `av_find_input_format`) |
|--------|---------------------|-------------------------------------------|
| PNG pipe | `image_png_pipe` | `png_pipe` |
| JPEG pipe | `image_jpeg_pipe` | `jpeg_pipe` |
| File images | `image2` | `image2` |
| Piped images | `image2pipe` | `image2pipe` |

Using the wrong name silently does nothing — `CONFIG_IMAGE_PNG_PIPE_DEMUXER` stays 0 and you won't see an error until runtime.

### Adding to configure.mjs

```js
decoders:  [..., 'av1'],            // --enable-decoder=av1
encoders:  [..., 'mjpeg'],          // --enable-encoder=mjpeg
demuxers:  [..., 'image_png_pipe'], // --enable-demuxer=image_png_pipe
muxers:    [..., 'mp4'],            // --enable-muxer=mp4
parsers:   [..., 'png'],            // --enable-parser=png
protocols: [..., 'file'],           // --enable-protocol=file
filters:   [..., 'drawtext'],       // --enable-filter=drawtext
```

### Verifying it compiled

After rebuild, check `vendor/ffmpeg/config_components.h`:

```bash
grep "CONFIG_PNG_DECODER\|CONFIG_IMAGE_PNG_PIPE_DEMUXER\|CONFIG_FILE_PROTOCOL\|CONFIG_ZLIB" \
    vendor/ffmpeg/config_components.h
```

All should be `1`. If any is `0`, the component didn't compile — check for typos in the name or missing external library.

## External library dependencies

Some codecs require an external library. For Emscripten builds, these come from Emscripten ports.

| Library | FFmpeg configure flag | emcc flag | Needed by |
|---------|-----------------------|-----------|-----------|
| zlib | `--enable-zlib` | `--use-port=zlib` | PNG decode, FLAC, MKV compression |
| libpng | `--enable-libpng` | `--use-port=libpng` | Alternative PNG encoder |
| libvpx | manual | not available as port | VP8/VP9 encode |

**zlib is required for PNG decode.** The PNG codec uses zlib for IDAT chunk decompression. Without it, `avformat_find_stream_info` opens the stream but can't get frame dimensions, and `avcodec_receive_frame` returns nothing useful. There's no compile-time error — just silent failure at runtime.

To wire up zlib (already done in the standard preset):
1. In `configure.mjs`: add `'--enable-zlib'` to the flags array and `'-lz'` to `extraLdflags`
2. In `build.sh` emcc link: add `--use-port=zlib`
3. Pre-populate the port cache once: `emcc --use-port=zlib -o /dev/null /dev/null 2>/dev/null`

## SIMD

`-msimd128` (WebAssembly SIMD128) is enabled in CPU builds via `--extra-cflags="-O3 -msimd128"` and the `emcc` link flag. It accelerates pixel processing in `libswscale` and color conversion — roughly 2× on inner loops. Size impact is zero.

Browser support: Chrome 91+, Firefox 89+, Safari 16.4+.

To remove SIMD (for a legacy-compat build), drop `-msimd128` from `extraCflags` in `configure.mjs` and from the CPU emcc link in `build.sh`.

## Exporting new C functions

When adding a new `EMSCRIPTEN_KEEPALIVE` function to `src/pipeline.c`:

1. Add to `DECODER_EXPORTS` or `CPU_EXPORTS` in `scripts/build.sh` — the export name is the C function name prefixed with `_`:
   ```bash
   CPU_EXPORTS="...,_my_new_function"
   ```
2. Relink (no full FFmpeg rebuild needed — just the final emcc step from building.md).
3. Call from JS: `mod.ccall('my_new_function', returnType, argTypes, args)`

**ccall type mapping:**

| C type | ccall string |
|--------|-------------|
| `int`, `int32_t`, `float`, `double` | `'number'` |
| `const char *` | `'string'` |
| `uint8_t *` (pointer) | `'number'` — allocate with `mod._malloc`, pass the pointer |
| `void` return | `null` |

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

After a major version bump: re-run `./configure --list-decoders` etc. to check for renamed components, then run the test suite. FFmpeg occasionally renames demuxers or changes codec behavior between major versions.

## WebGPU build specifics

The WebGPU build adds `pipeline_run_rgba_gpu` and `bench_scale_webgpu`. Additional requirements vs CPU:

- `--use-port=emdawnwebgpu` in both configure cflags and the emcc link
- `-s ASYNCIFY` in the emcc link (WebGPU calls are async)
- `-DCONFIG_WEBGPU` C define in the emcc link

Node.js has no WebGPU adapter, so GPU functions return -1 in tests. This is expected.
