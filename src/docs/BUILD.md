# Building wasmpeg

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) | ≥ 3.1.50 | `source emsdk_env.sh` before building |
| Node.js | ≥ 18 | runs configure.mjs and tests |
| ffmpeg (native) | any recent | needed for FATE pixel-compare tests only |

emdawnwebgpu ships as an Emscripten port (`--use-port=emdawnwebgpu`) — no separate Dawn build step is required on current emsdk.

## Build

```sh
# CPU-only wasm (faster, use for development)
TARGET=cpu bash scripts/build.sh

# WebGPU wasm
TARGET=webgpu bash scripts/build.sh

# Both (default)
bash scripts/build.sh
```

Outputs land in `dist/`:

```
dist/
  cpu.js      cpu.wasm
  webgpu.js   webgpu.wasm
```

### Build presets

`PRESET` env var is forwarded to `src/cli/configure.mjs`:

| PRESET | Codecs | Use |
|--------|--------|-----|
| `standard` (default) | full FFmpeg set | production |
| `minimal` | H.264 + VP8/9 + AAC + Opus only | faster iteration |

```sh
PRESET=minimal TARGET=cpu bash scripts/build.sh
```

## Verify

```sh
make verify
```

Runs in order:

1. `node tests/test.mjs` — unit tests against both builds
2. `node tests/fate.mjs` — FATE pixel-compare against native ffmpeg (requires `~/fate-suite` or `FATE_SAMPLES=/path`)

To download fate-suite samples:

```sh
rsync -av rsync://fate.ffmpeg.org/fate-suite/ ~/fate-suite/
```

## Bump FFmpeg

```sh
bash scripts/bump-ffmpeg.sh n8.2
```

This runs `git subtree pull` against the new tag and then `make verify`. Resolve any glue-line conflicts (the ~62 lines we add in `vendor/ffmpeg/`) before committing.

## Size check

```sh
bash tests/size.sh
```

Prints raw + gzip size of `dist/*.wasm` next to the equivalent `@ffmpeg/core` npm unpackaged size.
