#!/bin/bash
# Builds one libFuzzer binary per line in targets.txt, against the exact
# vendored FFmpeg source this repo ships — using FFmpeg's own real fuzzing
# harnesses (tools/target_dec_fuzzer.c, tools/target_dem_fuzzer.c) and its own
# real ossfuzz toolchain (the same combination oss-fuzz itself builds FFmpeg
# with upstream), just restricted to the codecs/containers wasmpeg's lgpl
# preset actually ships.
set -euo pipefail

SRC=${SRC:-/src/ffmpeg}
TARGETS_FILE=${TARGETS_FILE:-/src/targets.txt}
OUT=${OUT:-/out}
mkdir -p "$OUT"

decoders=$(grep '^dec:' "$TARGETS_FILE" | cut -d: -f2 | paste -sd, -)
demuxers=$(grep '^dem:' "$TARGETS_FILE" | cut -d: -f2 | paste -sd, -)
# Parser names mostly match decoder names; mp3's parser is called mpegaudio.
parsers=$(echo "$decoders" | sed 's/\bmp3\b/mpegaudio/g')

cd "$SRC"
./configure \
    --toolchain=clang-asan-ubsan-fuzz \
    --enable-ossfuzz \
    --cc=clang --cxx=clang++ \
    --disable-shared --enable-static \
    --disable-programs --disable-doc \
    --disable-htmlpages --disable-manpages --disable-podpages --disable-txtpages \
    --disable-x86asm --disable-inline-asm \
    --disable-everything \
    --enable-zlib \
    --enable-decoder="$decoders" \
    --enable-parser="$parsers" \
    --enable-demuxer="$demuxers" \
    --enable-protocol=file \
    --optflags=-O1

make clean
make -j"$(nproc)"

grep -E '^(dec|dem):' "$TARGETS_FILE" | while IFS=: read -r kind name; do
    case "$kind" in
        dec) target="tools/target_dec_${name}_fuzzer" ;;
        dem) target="tools/target_dem_${name}_fuzzer" ;;
    esac
    make "$target"
    cp "$target" "$OUT/${kind}_${name}"
done

echo "built $(ls "$OUT" | wc -l) fuzz targets in $OUT"
