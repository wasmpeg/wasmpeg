---
title: "Building from source"
description: "Compile the FFmpeg WASM binaries yourself with the Emscripten SDK — full build and fast incremental relinks."
weight: 100
---
You only need to build from source to change the codec set, hack on `src/pipeline.c`, or
produce the GPL binaries — not published to npm yet. The LGPL packages ship prebuilt `dist/*.wasm`.

## Prerequisites

- **Node.js** ≥ 18
- **Emscripten SDK (emsdk)** — pinned to **6.0.8** (matches CI; see
  [a note on emsdk versions](#a-note-on-emsdk-versions) for why `latest` isn't safe to
  assume and older 3.1.x releases won't build the WebGPU target).

{{< steps >}}
{{% step %}}
Install emsdk once:

   ```sh
   git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
   cd ~/emsdk
   ./emsdk install 6.0.8 && ./emsdk activate 6.0.8
   ```
{{% /step %}}
{{% step %}}
Activate it in **every** new shell before building (it doesn't persist):

   ```sh
   source ~/emsdk/emsdk_env.sh
   ```
{{% /step %}}
{{< /steps >}}

### A note on emsdk versions

Two real, version-specific gotchas, both worth knowing if you're pinning a different
emsdk yourself:

- **3.1.64 through at least 3.1.74 ship a broken `wasm-opt`/LLD pairing.** `emcc` still
  passes `--enable-bulk-memory-opt` to `wasm-opt`'s post-link optimization pass, but the
  bundled `wasm-opt` no longer recognizes that flag. For the CPU target this is silently
  non-fatal — you get a working but unoptimized, larger `.wasm` — but FFmpeg's own
  `./configure` sanity-checks the compiler the same way, and *there* the failure is fatal.
  6.0.8 has this fixed.
- **`--use-port=emdawnwebgpu` doesn't exist at all in the 3.1.x series** — it's a
  considerably newer addition, tracking Dawn's own emscripten packaging. Once it's
  available, it also requires C++ linkage even for a trivial C sanity-check compile —
  hence `-s DEFAULT_TO_CXX=1` on both the `configure.mjs`-generated `--extra-ldflags` and
  the final `emcc src/pipeline.c` link in `scripts/build.sh` for the `webgpu` target.

## Build

Codec selection is data-driven by a preset. The two shipping presets:

```sh
# LGPL — @wasmpeg/core and @wasmpeg/cpu
PRESET=lgpl TARGET=cpu bash scripts/build.sh   # → dist/cpu.js + dist/cpu.wasm

# GPL — not yet published, adds libx264/libx265 encode
PRESET=gpl  TARGET=cpu bash scripts/build.sh   # → dist/gpl-cpu.js + dist/gpl-cpu.wasm
```

`TARGET` is `cpu` (default), `webgpu`, or `both`. The GPL build writes to `dist/gpl-*`
and uses its own `build-gpl-*` object directories, so LGPL and GPL objects never mix.

```sh
TARGET=both PRESET=lgpl bash scripts/build.sh   # cpu + webgpu
```

| `PRESET` / `TARGET` | Output files |
|---------------------|--------------|
| `lgpl` / `cpu` | `dist/cpu.js`, `dist/cpu.wasm` |
| `lgpl` / `webgpu` | `dist/webgpu.js`, `dist/webgpu.wasm` |
| `gpl` / `cpu` | `dist/gpl-cpu.js`, `dist/gpl-cpu.wasm` |
| `gpl` / `webgpu` | `dist/gpl-webgpu.js`, `dist/gpl-webgpu.wasm` |

There are also `minimal` and `standard` presets for fast dev iteration — see
[configuration](/docs/build/configuration/).

{{< aside type="note" >}}
The `gpl` preset adds H.264/H.265 *encode* via libx264/libx265, which are external GPL
libraries that have to be cross-compiled for wasm first. The flags and encoder entries are
present but commented out in `configure.mjs` until those ports are in place — so a stock
`PRESET=gpl` build today differs from `lgpl` mainly by license posture. Check
`src/cli/configure.mjs` for the current state before depending on x264/x265 encode.
{{< /aside >}}

## What the build does

`scripts/build.sh` runs three stages:

1. **Configure** — `src/cli/configure.mjs` generates `configure-<target>.sh`, which runs
   `emconfigure ./configure` inside `vendor/ffmpeg` with `--disable-everything` plus
   selective `--enable-*` flags from the preset. *Never edit the generated script by
   hand — it's overwritten every build.*
2. **Compile** — `emmake make -j$(nproc) install` builds the FFmpeg static libraries.
   This is the slow stage (~3–5 min on 16 cores).
3. **Link** — `emcc src/pipeline.c` links against those static libs into the final
   `dist/*.{js,wasm}`. Under 30 seconds.

The configure step always starts from `--disable-everything` and re-enables only the
libraries (`avcodec`, `avformat`, `avfilter`, `avutil`, `swscale`, `swresample`) and the
exact components the preset names. That keeps the binary small and makes the component list
in [codecs](/docs/formats/codecs/) an exact reflection of the preset rather than whatever FFmpeg ships
by default.

Notable flags the generator and link step set:

| Flag | Purpose |
|------|---------|
| `-O3 -msimd128` | WebAssembly SIMD128 — ~2× faster pixel ops, zero size cost (CPU build) |
| `--use-port=zlib` / `--enable-zlib` | Required for PNG and FLAC decode, and MKV compression |
| `--enable-protocol=file` | Required for `decoder_open_file()` to read the WASM FS |
| `--disable-x86asm --disable-inline-asm` | No native asm under wasm — SIMD comes from `-msimd128` |
| `--disable-pthreads --disable-network --disable-autodetect` | Single-threaded, sandboxed, deterministic component set |
| `-s MODULARIZE=1 -s EXPORT_ES6=1` | Emit an ES module with a named factory (`FFmpegCPU` / `FFmpegWebGPU`) |
| `-s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=64MiB` | Start at 64 MiB, grow as large frames demand |
| `--use-port=emdawnwebgpu`, `-s ASYNCIFY`, `-DCONFIG_WEBGPU` | WebGPU build only |

The linker also exports a fixed list of `_`-prefixed C entry points (decoder, audio, probe,
and encoder families) plus the runtime helpers `ccall`, `cwrap`, `HEAPU8`, and `FS`. The
authoritative list is the `*_EXPORTS` variables at the top of `scripts/build.sh`.

## Incremental relink

If you only touched `src/pipeline.c` or the JS under `src/js/`, skip the FFmpeg rebuild
and just relink against the already-built static libraries (under 30s). The exact `emcc`
command — including the full `EXPORTED_FUNCTIONS` list — lives in `scripts/build.sh`;
copy it and point `-L` at your existing `build-cpu/lib`.

{{< aside type="tip" >}}
The first build with `--use-port=zlib` downloads and caches the port. Seed it once for a
clean offline build: `emcc --use-port=zlib -o /dev/null /dev/null 2>/dev/null`.
{{< /aside >}}

## Verify

```sh
node tests/test.mjs    # functional suite across all three API layers
```

The FATE coverage and correctness harnesses (`tests/compat.mjs`, `tests/fate.mjs`)
default to the `gpl-cpu` build; override with `WASM_BUILD=cpu`.
