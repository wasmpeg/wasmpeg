# Building wasmpeg

## Prerequisites

| Tool | Version | How to get |
|------|---------|------------|
| Node.js | ≥ 18 | `nvm install 22` |
| emsdk | 6.0.0 | See below |

```bash
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk
./emsdk install 6.0.0
./emsdk activate 6.0.0
```

Every terminal session that builds needs:
```bash
source ~/emsdk/emsdk_env.sh
```

## Quick start

```bash
source ~/emsdk/emsdk_env.sh
PRESET=standard TARGET=cpu bash scripts/build.sh
```

Output:
```
dist/cpu.js    (~70KB JS glue)
dist/cpu.wasm  (~3.8MB)
```

Other targets:
```bash
TARGET=webgpu bash scripts/build.sh   # WebGPU build
TARGET=both   bash scripts/build.sh   # both
```

## How the build works

```
src/cli/configure.mjs
    ↓  generates
configure-cpu.sh
    ↓  runs
vendor/ffmpeg/configure  (via emconfigure)
    ↓  produces
vendor/ffmpeg/config.h + config_components.h
    ↓
emmake make -j$(nproc) install
    ↓  produces
build-cpu/lib/  (libavcodec.a, libavformat.a, etc.)
    ↓
emcc src/pipeline.c + build-cpu/lib/*.a
    ↓  produces
dist/cpu.js + dist/cpu.wasm
```

**`src/cli/configure.mjs` is the single source of truth** for what goes into the build — codecs, filters, protocols, external libs. Never edit `configure-cpu.sh` directly; it's regenerated on every build.

The FFmpeg configure step runs `emconfigure ./configure` inside `vendor/ffmpeg/` with `--disable-everything` then selective `--enable-*` flags from the preset. Notable flags:

- `--extra-cflags="-O3 -msimd128"` — SIMD128 baked in, no size increase
- `--enable-zlib` + `-lz` — required for PNG/FLAC decoders (IDAT decompression)
- `--enable-protocol=file` — required for `decoder_open_file()` to read from WASM FS

The `make install` step is the slow one — about 3–5 minutes on 16 cores. The final `emcc` link is fast (under 30 seconds).

## Incremental builds

If you only changed `src/pipeline.c` or `src/js/*.js`, skip the full rebuild and just relink:

```bash
source ~/emsdk/emsdk_env.sh

DECODER_EXPORTS="_decoder_open,_decoder_open_format,_decoder_open_file,_decoder_width,_decoder_height,_decoder_fps_num,_decoder_fps_den,_decoder_next_frame,_decoder_close"
CPU_EXPORTS="_malloc,_free,_pipeline_version,_pipeline_run_rgba,_bench_scale_cpu,$DECODER_EXPORTS"

emcc src/pipeline.c \
    -I vendor/ffmpeg \
    -I build-cpu/include \
    -L build-cpu/lib \
    -lavfilter -lavcodec -lavformat -lavutil -lswscale -lswresample \
    -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 \
    -s EXPORT_NAME="FFmpegCPU" \
    -s EXPORTED_FUNCTIONS="[$CPU_EXPORTS]" \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8","FS"]' \
    -s INITIAL_MEMORY=67108864 -s ALLOW_MEMORY_GROWTH=1 \
    -O3 -msimd128 \
    --use-port=zlib \
    -o dist/cpu.js
```

If you changed codec/demuxer/filter lists in `configure.mjs`, you need configure + make + link — but not `make distclean`. FFmpeg's incremental make only recompiles files that depend on changed config flags:

```bash
source ~/emsdk/emsdk_env.sh
node src/cli/configure.mjs --preset=standard --target=cpu
bash configure-cpu.sh
cd vendor/ffmpeg && emmake make -j$(nproc) install && cd ../..
# then the emcc link above
```

## Environment notes

- `source emsdk_env.sh` must run in the same shell as the build commands. It does not persist.
- `--use-port=zlib` requires the Emscripten zlib port to be cached. Run this once: `emcc --use-port=zlib -o /dev/null /dev/null 2>/dev/null`
- `configure-cpu.sh`, `configure-webgpu.sh`, `build-cpu/`, and `build-webgpu/` are gitignored — generated/local only.
