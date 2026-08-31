# Fuzzing

A lightweight, local OSS-Fuzz-style setup: real FFmpeg fuzz harnesses
(`vendor/ffmpeg/tools/target_dec_fuzzer.c`, `target_dem_fuzzer.c`) built with
FFmpeg's own real `clang-asan-ubsan-fuzz` toolchain — the same combination
upstream OSS-Fuzz itself builds FFmpeg with — against the exact vendored
source this repo ships. Not registered with Google's OSS-Fuzz; this is a
standalone container that builds and runs the same harnesses ourselves.

It's scoped to `targets.txt`: the decoders/demuxers wasmpeg's `lgpl` preset
actually ships, restricted further to the ones most likely to see untrusted
bytes from a real user (modern web video/audio codecs, common images, and the
two containers browsers actually produce). Not FFmpeg's full fuzz target set —
see `targets.txt` for the exact list and why.

## Run it locally

```sh
docker build -f fuzz/Dockerfile -t wasmpeg-fuzz .

mkdir -p /tmp/fuzz-corpus /tmp/fuzz-crashes
docker run --rm \
  -v /tmp/fuzz-corpus:/corpus \
  -v /tmp/fuzz-crashes:/crashes \
  -v "$PWD/fate-suite:/fate-suite:ro" \
  -e TIME_PER_TARGET=300 \
  wasmpeg-fuzz
```

- `/corpus` persists libFuzzer's coverage-guided corpus across runs — mount a
  real directory (or reuse one from a previous run) so it actually grows
  instead of restarting from empty every time.
- `/fate-suite` is optional. If mounted, an empty per-target corpus gets a
  one-time seed of real-world samples matching that codec's name — the repo
  already has hundreds of these checked out for FATE testing. Skipped
  entirely if not mounted; libFuzzer bootstraps coverage from nothing just
  fine, it just takes longer to get there.
- `TIME_PER_TARGET` (seconds, default 300) is a per-binary budget, not a
  total — 16 targets × 300s ≈ 80 minutes.
- Exit code is non-zero, and `/crashes` is non-empty, iff something was
  found. A crash file there is a real minimized reproducer — replay it
  directly against the binary that found it: `/out/dec_png crashes/dec_png-<hash>`.

## Run one target by hand

```sh
docker run --rm --entrypoint /out/dec_h264 wasmpeg-fuzz -max_total_time=60 /corpus/dec_h264
```

Every binary in `/out` is a standalone libFuzzer executable — `-help=1` lists
libFuzzer's own flags.

## What's in here

- `Dockerfile` — builds the image: installs clang + the sanitizer runtimes,
  copies in `vendor/ffmpeg`, runs `build.sh`, then wires `run.sh` as the
  entrypoint.
- `targets.txt` — one `dec:<name>` or `dem:<name>` per line. Single source of
  truth for both `build.sh` (what to compile) and `run.sh` (what to run).
- `build.sh` — configures the vendored FFmpeg source with
  `--toolchain=clang-asan-ubsan-fuzz --enable-ossfuzz`, `--disable-everything`
  plus exactly the decoders/parsers/demuxers `targets.txt` names, and builds
  one binary per target into `/out`.
- `run.sh` — runs every binary in `/out` for `TIME_PER_TARGET` seconds each
  against its persistent corpus, seeding from `/fate-suite` when present,
  collecting crashes, and failing loudly if any were found.

## Adding a target

Add a `dec:<name>` or `dem:<name>` line to `targets.txt` — the name has to
match a real FFmpeg decoder/demuxer registration name (grep
`vendor/ffmpeg/libavcodec/allcodecs.c` / `libavformat/allformats.c`). Decoder
targets also need a matching parser enabled in `build.sh`'s `parsers=`
line if one exists for that codec (`grep ff_..._parser
vendor/ffmpeg/libavcodec/parsers.c`) — `build.sh` derives it automatically
from the decoder list except for `mp3`, whose parser is named `mpegaudio`.

## Why this scope, not all of FFmpeg

OSS-Fuzz itself builds and fuzzes essentially every decoder/demuxer/encoder/
bitstream-filter FFmpeg has — hundreds of binaries. That's real, valuable
coverage, but most of it is code wasmpeg's `lgpl` build doesn't compile in at
all. Fuzzing it here would mean maintaining a much bigger build for bugs a
wasmpeg user could never actually trigger. `targets.txt` stays intentionally
narrow: it's the surface a browser user's uploaded file actually reaches.
