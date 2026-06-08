#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor/ffmpeg"
DIST="$ROOT/dist"

PRESET="${PRESET:-standard}"
TARGET="${TARGET:-both}"
NPROC="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

DECODER_EXPORTS="_decoder_open,_decoder_open_format,_decoder_open_file,_decoder_width,_decoder_height,_decoder_fps_num,_decoder_fps_den,_decoder_next_frame,_decoder_close"
CPU_EXPORTS="_malloc,_free,_pipeline_version,_pipeline_run_rgba,_bench_scale_cpu,$DECODER_EXPORTS"
WEBGPU_EXPORTS="_malloc,_free,_pipeline_version,_pipeline_run_rgba,_pipeline_run_rgba_gpu,_bench_scale_cpu,_bench_scale_webgpu,$DECODER_EXPORTS"

mkdir -p "$DIST"

build_target() {
    local t="$1"
    local webgpu="$2"
    local build_dir="$ROOT/build-$t"

    echo "==> configuring $t (preset=$PRESET)..."
    node "$ROOT/src/cli/configure.mjs" --preset="$PRESET" --target="$t"
    bash "$ROOT/configure-$t.sh"

    echo "==> building ffmpeg libs ($t)..."
    (cd "$VENDOR" && emmake make -j"$NPROC" install)

    echo "==> linking $t wasm..."
    if [ "$webgpu" = "1" ]; then
        emcc "$ROOT/src/pipeline.c" \
            -I"$ROOT/vendor/ffmpeg" \
            -I"$build_dir/include" \
            -L"$build_dir/lib" \
            -lavfilter -lavcodec -lavformat -lavutil -lswscale -lswresample \
            --use-port=emdawnwebgpu \
            -s WASM=1 \
            -s ASYNCIFY \
            -s MODULARIZE=1 \
            -s EXPORT_ES6=1 \
            -s EXPORT_NAME="FFmpegWebGPU" \
            -s EXPORTED_FUNCTIONS="[$WEBGPU_EXPORTS]" \
            -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8","FS"]' \
            -s INITIAL_MEMORY=67108864 \
            -s ALLOW_MEMORY_GROWTH=1 \
            -DCONFIG_WEBGPU \
            -O3 \
            -o "$DIST/webgpu.js"
    else
        emcc "$ROOT/src/pipeline.c" \
            -I"$ROOT/vendor/ffmpeg" \
            -I"$build_dir/include" \
            -L"$build_dir/lib" \
            -lavfilter -lavcodec -lavformat -lavutil -lswscale -lswresample \
            -s WASM=1 \
            -s MODULARIZE=1 \
            -s EXPORT_ES6=1 \
            -s EXPORT_NAME="FFmpegCPU" \
            -s EXPORTED_FUNCTIONS="[$CPU_EXPORTS]" \
            -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8","FS"]' \
            -s INITIAL_MEMORY=67108864 \
            -s ALLOW_MEMORY_GROWTH=1 \
            -O3 -msimd128 \
            --use-port=zlib \
            -o "$DIST/cpu.js"
    fi

    echo "==> $t done -> dist/${t}.{js,wasm}"
}

case "$TARGET" in
    cpu)    build_target cpu 0 ;;
    webgpu) build_target webgpu 1 ;;
    both)   build_target cpu 0 && build_target webgpu 1 ;;
    *) echo "unknown target: $TARGET"; exit 1 ;;
esac

echo ""
echo "build complete:"
ls -lh "$DIST"
