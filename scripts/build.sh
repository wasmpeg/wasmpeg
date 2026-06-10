#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor/ffmpeg"
DIST="$ROOT/dist"

PRESET="${PRESET:-standard}"
TARGET="${TARGET:-both}"
NPROC="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

# GPL preset gets its own build dirs and output prefix so LGPL and GPL
# objects never mix. All other presets share the standard build dirs.
if [ "$PRESET" = "gpl" ]; then
    BUILD_SUFFIX="-gpl"
    OUT_PREFIX="gpl-"
    echo "==> GPL build — output will be dist/gpl-*.{js,wasm}"
    echo "    NOTE: linking this binary into a closed-source product requires GPL compliance."
else
    BUILD_SUFFIX=""
    OUT_PREFIX=""
fi

DECODER_EXPORTS="_decoder_open,_decoder_open_format,_decoder_open_file,_decoder_width,_decoder_height,_decoder_fps_num,_decoder_fps_den,_decoder_next_frame,_decoder_next_raw_frame,_decoder_close"
AUDIO_EXPORTS="_audio_open,_audio_open_format,_audio_channels,_audio_sample_rate,_audio_next_samples,_audio_close"
PROBE_EXPORTS="_probe_open,_probe_format_name,_probe_duration_ms,_probe_stream_count,_probe_stream_type,_probe_width,_probe_height,_probe_fps_num,_probe_fps_den,_probe_sample_rate,_probe_channels,_probe_bitrate,_probe_close"
ENCODER_EXPORTS="_encoder_open,_encoder_push_rgba,_encoder_finish,_encoder_output_ptr,_encoder_output_size,_encoder_close"
COMMON_EXPORTS="_malloc,_free,_pipeline_version,_pipeline_run_rgba,_bench_scale_cpu,$DECODER_EXPORTS,$AUDIO_EXPORTS,$PROBE_EXPORTS,$ENCODER_EXPORTS"
CPU_EXPORTS="$COMMON_EXPORTS"
WEBGPU_EXPORTS="$COMMON_EXPORTS,_pipeline_run_rgba_gpu,_bench_scale_webgpu"

mkdir -p "$DIST"

build_target() {
    local t="$1"
    local webgpu="$2"
    local build_dir="$ROOT/build${BUILD_SUFFIX}-$t"
    local out_js="$DIST/${OUT_PREFIX}${t}.js"

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
            -o "$out_js"
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
            -o "$out_js"
    fi

    echo "==> $t done -> dist/${OUT_PREFIX}${t}.{js,wasm}"
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
