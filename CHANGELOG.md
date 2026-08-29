# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- The WebGPU target builds. `--enable-webgpu` is wired into the vendored FFmpeg
  `configure`, `hwcontext_webgpu.h` is installed, and the emcc link pulls in
  zlib and simd128. `dist/webgpu.wasm` is 9.34 MiB raw / 3.85 MiB gzipped,
  against 7.07 MiB / 3.16 MiB for the CPU build. This target had never been
  configured, compiled or linked before.
- TypeScript declarations for the public API (`src/js/index.d.ts`).
- A royalty-free-only build preset (`free`) covering VP8/VP9/AV1/Theora,
  Opus/Vorbis/FLAC, the lossless codecs and the image formats.
- `gpu.onLog()` / `gpu.offLog()` for subscribing to module stdout/stderr.
- `-vframes` / `-frames` now cap a decode-only `exec()`.
- `probe()` and `decodeAudio()` accept WASM filesystem paths, matching `decode()`.
- CI: build, `make verify`, and a DCO sign-off check on pull requests.

### Fixed
- `import wasmpeg from 'wasmpeg'` returned `undefined`; the package had no
  default export despite the README documenting one.
- `FFmpeg` loaded a second WASM module, doubling resident memory and giving
  `writeFile()` a filesystem `exec()` could not see. Both now share one module.
- A failed filter op leaked its decoder session; a few failures exhausted the
  eight-slot pool.
- Unknown boolean flags (`-nostats`, `-dn`, …) consumed the output filename.
- Global flags (`-y`, `-hide_banner`, `-loglevel`, …) are now global wherever
  they appear rather than binding to the next input.
- `scale=-1:H`, `scale=iw/2:ih/2` and other expressions silently fell back to
  the source size; they are now resolved.
- `encode()` decoded one frame past its `frames` budget.
- The `exec()` audio path dropped the filename format hint that
  `decodeAudio()` applies.
- The WebGPU target now compiles with `-msimd128`, matching the CPU target, so
  a GPU-vs-CPU comparison is not measuring a scalar baseline.
- Preset names corrected to FFmpeg's own: `targa`, not `tga`; dropped the
  nonexistent `image_tga_pipe` demuxer.
- `package.json` pointed at a repository URL that does not exist.
- Loaders fall back to the CPU build when the WebGPU artifact is absent instead
  of failing in exactly the browsers the project targets.

### Documentation
- `pipeline_version` returns a string, not an int.
- Probe bitrate is kb/s; the README implied bits/s.
- The npm packages are unpublished, and audio encode has no reachable API.
