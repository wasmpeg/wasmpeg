# Building

## Prerequisites

- **Node.js** ≥ 18
- **emsdk** 6.0.0

Install emsdk once:

```bash
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk
./emsdk install 6.0.0
./emsdk activate 6.0.0
```

> **Note:** `source ~/emsdk/emsdk_env.sh` must be run in every new terminal session before building. It does not persist across shells.

## Building

```bash
source ~/emsdk/emsdk_env.sh
PRESET=standard TARGET=cpu bash scripts/build.sh
```

This produces `dist/cpu.js` (~70 KB) and `dist/cpu.wasm` (~3.8 MB).

To build both targets:

```bash
TARGET=both bash scripts/build.sh
```

Available targets: `cpu` (default), `webgpu`, `both`.

## How it works

`scripts/build.sh` runs three stages:

1. **Configure** — `src/cli/configure.mjs` generates `configure-cpu.sh`, which runs `emconfigure ./configure` inside `vendor/ffmpeg` with `--disable-everything` and selective `--enable-*` flags drawn from the preset. Never edit `configure-cpu.sh` by hand; it's regenerated on every build. See [configuration.md](configuration.md) for how presets work.

2. **Compile** — `emmake make -j$(nproc) install` builds the FFmpeg static libraries into `build-cpu/lib/`. This is the slow step — roughly 3–5 minutes on 16 cores.

3. **Link** — `emcc src/pipeline.c` links against the static libraries to produce the final WASM binary. This takes under 30 seconds.

Notable compile flags:

| Flag | Purpose |
|------|---------|
| `--extra-cflags="-O3 -msimd128"` | WebAssembly SIMD128 — zero size cost, ~2× faster pixel ops |
| `--enable-zlib` / `-lz` | Required for PNG and FLAC decode |
| `--enable-protocol=file` | Required for `decoder_open_file()` to access the WASM virtual FS |
| `--use-port=zlib` | Supplies `libz.a` from Emscripten's port cache at link time |

## Incremental rebuilds

If you only changed `src/pipeline.c` or the JS files under `src/js/`, skip the full FFmpeg build and just relink:

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
    -O3 -msimd128 --use-port=zlib \
    -o dist/cpu.js
```

If you changed codec or filter lists in `configure.mjs`, run configure and make — but not `make distclean`. FFmpeg's incremental make only recompiles what changed:

```bash
source ~/emsdk/emsdk_env.sh
node src/cli/configure.mjs --preset=standard --target=cpu
bash configure-cpu.sh
cd vendor/ffmpeg && emmake make -j$(nproc) install && cd ../..
# then the emcc link above
```

> **Note:** The first time you build with `--use-port=zlib`, Emscripten downloads and caches the port. Seed it once before a full offline build: `emcc --use-port=zlib -o /dev/null /dev/null 2>/dev/null`
