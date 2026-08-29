# Contributing to wasmpeg

Thanks for helping out. This guide covers the dev setup, the build, how the codec
selection works, the test workflow, and the rules for getting a PR merged.

## Project layout

```
src/
  pipeline.c          C entry points (decode / scale / probe / encode / bench), one ABI
  cli/configure.mjs   data-driven codec selection → generates the ./configure flags
  js/
    index.js          public exports
    wasmpeg.mjs       high-level API (default export): decode/scale/probe/encode/run
    ffmpeg.js         FFmpeg class — ffmpeg.wasm-compatible surface
    gpu.js            low-level typed API over the C ABI
    exec.mjs          ffmpeg-arg parser + input normalization + dispatch
scripts/build.sh      configure → make → emcc link, per preset/target
tests/
  test.mjs            unit/integration suite (no framework, run with node)
  compat.mjs          FATE compatibility tracker → COMPAT.md + results/history.json
docs/                 building / configuration / testing / api reference
vendor/ffmpeg         vendored FFmpeg source (the authoritative list of component names)
```

## Prerequisites

- **Node.js ≥ 18**
- **Emscripten SDK** — see [docs/building.md](docs/building.md) for the pinned version
  and one-time install. `source ~/emsdk/emsdk_env.sh` must be run in each new shell
  before building.

## Build

```sh
source ~/emsdk/emsdk_env.sh

# LGPL build (the `wasmpeg` package)
PRESET=lgpl TARGET=cpu bash scripts/build.sh   # → dist/cpu.js + dist/cpu.wasm

# GPL build (the `wasmpeg-full` package — adds libx264/libx265)
PRESET=gpl  TARGET=cpu bash scripts/build.sh   # → dist/gpl-cpu.js + dist/gpl-cpu.wasm
```

`build.sh` runs three stages: **configure** (`configure.mjs` emits `configure-*.sh`,
which runs `./configure` inside `vendor/ffmpeg`), **make** (builds the static libs),
and **link** (`emcc` produces the `.js` + `.wasm`). The generated `configure-*.sh` is
overwritten on every build — never edit it by hand.

## Adding or changing a codec, demuxer, or filter

All format decisions live in [src/cli/configure.mjs](src/cli/configure.mjs). To add
support for something:

1. **Find the exact component name** FFmpeg expects. The vendored source is the
   source of truth:
   ```sh
   cd vendor/ffmpeg
   ./configure --list-decoders   # also --list-demuxers, --list-parsers, --list-filters
   ```
2. **Add the name** to the relevant array in the right preset in `configure.mjs`
   (`decoders`, `demuxers`, `parsers`, `muxers`, `filters`, …). A decoder usually also
   needs its demuxer and parser.
3. **Rebuild** and confirm with a sample file.

See [docs/configuration.md](docs/configuration.md) for how presets compose.

## Testing

Three test layers, each answering a different question. The first two gate every
commit (`make verify`); the last two are tracking reports run against a build.

| Run | Layer | Question |
|-----|-------|----------|
| `node tests/test.mjs` | JS API + C pipeline | does the API behave? (unit/integration) |
| `node tests/fate-runner.mjs` | `exec()` arg parser | does every FATE command parse and route right? |
| `node tests/compat.mjs` | decode pipeline | does it decode without erroring? → [COMPAT.md](COMPAT.md) |
| `node tests/fate.mjs` | decode pipeline | does it decode to the exact bytes? → [CORRECTNESS.md](CORRECTNESS.md) |

Always run `node tests/test.mjs` before committing — it must be green. It's a single
framework-free file using an `ok(message, condition)` helper, grouped by layer
(pipeline / decoder / `FFmpeg` class / `gpu`). Add assertions to the group that matches
what you touched. See [docs/testing.md](docs/testing.md).

### Compatibility and correctness (FATE)

Both reports need a `gpl-cpu` build and run against the FATE sample suite. `gpl-cpu`
is used because it's the build our release CI will cut with the broadest codec set —
but since `gpl` only adds encoders on top of `lgpl` (same decoders/demuxers/parsers)
and FATE's coverage/correctness tests are decode-only, the number is identical across
every build we ship:

```sh
make compat    # node tests/compat.mjs — coverage, writes COMPAT.md + results/history.json
make fate      # node tests/fate.mjs   — correctness, writes CORRECTNESS.md + results/correctness-history.json
```

`compat.mjs` checks that a file decodes at all. `fate.mjs` is stricter: it decodes each
frame in its native pixel format and compares the per-frame Adler-32 to FFmpeg's
vendored reference in `vendor/ffmpeg/tests/ref/fate/`, so a test passes only when the
output is byte-identical. No native ffmpeg needed — the references match our exact
FFmpeg version.

**Keep the score honest.** These are *measurement* tools. Prefer fixing gaps in the
library (`configure.mjs` for missing codecs, `src/js` / `src/pipeline.c` for behavior)
over routing tricks in the harness that lift the number without helping a real user.
Correctness is the number that means something: coverage says we attempt a codec,
correctness says we decode it right.

## Maintenance tasks

Check WASM size against `@ffmpeg/core` after a build:

```sh
bash tests/size.sh        # raw + gzip size of dist/*.wasm vs @ffmpeg/core unpackaged
```

Pull a newer FFmpeg release into `vendor/ffmpeg`:

```sh
bash scripts/bump-ffmpeg.sh n8.2     # git subtree pull to the tag, then `make verify`
```

The bump touches the ~62 glue lines we carry in `vendor/ffmpeg/`. Resolve any
conflicts on those lines before committing.

## Commits & pull requests

- **Atomic commits.** One logical change per commit; split unrelated changes.
- **Sign off every commit (DCO).** Pass `-s` so git adds the trailer:
  ```sh
  git commit -s -m "your message"
  ```
  By signing off you certify you wrote the code and may contribute it under the
  project license — see the [`DCO`](DCO) file for the full text. **PRs without
  sign-offs will not be merged.**
- **Single-line commit messages** describing the change in the imperative.
- **Green before you push:** `node tests/test.mjs` must pass.

## License of contributions

`wasmpeg` is LGPL-2.1-or-later and `wasmpeg-full` is GPL-2.0-or-later. By contributing
you agree your changes are licensed under the same terms.
