/**
 * gpu — typed pipeline API backed by pipeline_run_rgba_gpu + decoder_* + audio_* + probe_* + encoder_*.
 *
 * Usage:
 *   import { gpu } from 'wasmpeg';
 *   await gpu.load();
 *
 *   // scale via WebGPU (falls back to CPU silently if no WebGPU)
 *   const out = gpu.scale(pixels, srcW, srcH, dstW, dstH);
 *
 *   // decode a video file frame-by-frame
 *   const dec = gpu.createDecoder(fileBytes);
 *   while (true) {
 *       const frame = dec.nextFrame();
 *       if (!frame) break;
 *   }
 *   dec.close();
 *
 *   // decode audio
 *   const aud = gpu.createAudioDecoder(fileBytes);
 *   while (true) {
 *       const chunk = aud.nextSamples();
 *       if (!chunk) break;
 *   }
 *   aud.close();
 *
 *   // probe
 *   const info = gpu.probe(fileBytes);
 *
 *   // encode frames
 *   const enc = gpu.createEncoder({ fmt: 'image2', codec: 'mjpeg', width: 1280, height: 720 });
 *   enc.pushRgba(rgbaData, 1280, 720, 0);
 *   const output = enc.finish();
 *   enc.close();
 */

let _mod    = null;
let _hasGPU = false;

async function load({ wasmPath } = {}) {
    if (_mod) return;

    _hasGPU = typeof navigator !== 'undefined' && !!navigator.gpu;

    const path = wasmPath ?? (
        _hasGPU
            ? new URL('../../dist/webgpu.js', import.meta.url).href
            : new URL('../../dist/cpu.js',    import.meta.url).href
    );

    const isNode = typeof process !== 'undefined' && process.versions?.node;
    let nodeOpts = {};
    if (isNode) {
        const { default: fsMod } = await import('node:fs');
        nodeOpts = { wasmBinary: fsMod.readFileSync(new URL(path).pathname.replace(/\.js$/, '.wasm')) };
    }

    const { default: factory } = await import(/* @vite-ignore */ path);
    _mod = await factory(nodeOpts);
}

function assertLoaded() {
    if (!_mod) throw new Error('call gpu.load() first');
}

function allocBytes(buf) {
    const ptr = _mod._malloc(buf.byteLength);
    _mod.HEAPU8.set(buf, ptr);
    return ptr;
}

/* ── video scale ─────────────────────────────────────────────────────────── */

function scale(srcRgba, srcW, srcH, dstW, dstH, filtergraph) {
    assertLoaded();
    const fg = filtergraph ?? (_hasGPU
        ? `scale_webgpu=${dstW}:${dstH}`
        : `scale=${dstW}:${dstH}`);

    const fn     = _hasGPU ? 'pipeline_run_rgba_gpu' : 'pipeline_run_rgba';
    const srcPtr = allocBytes(srcRgba);
    const dstPtr = _mod._malloc(dstW * dstH * 4);

    const ret = _mod.ccall(fn, 'number',
        ['number','number','number','number','number','number','string'],
        [srcPtr, srcW, srcH, dstPtr, dstW, dstH, fg]);

    const out = new Uint8ClampedArray(_mod.HEAPU8.buffer, dstPtr, dstW * dstH * 4).slice();
    _mod._free(srcPtr);
    _mod._free(dstPtr);
    if (ret !== 0) throw new Error(`scale failed: ${ret}`);
    return out;
}

/* ── video decoder ───────────────────────────────────────────────────────── */

function _wrapVideoDecoder(handle) {
    const width  = _mod.ccall('decoder_width',   'number', ['number'], [handle]);
    const height = _mod.ccall('decoder_height',  'number', ['number'], [handle]);
    const fpsNum = _mod.ccall('decoder_fps_num', 'number', ['number'], [handle]);
    const fpsDen = _mod.ccall('decoder_fps_den', 'number', ['number'], [handle]);

    let bufSize  = width * height * 4;
    let frameBuf = _mod._malloc(bufSize);

    return {
        width,
        height,
        fps: fpsNum / fpsDen,

        nextFrame(dstW = width, dstH = height) {
            const needed = dstW * dstH * 4;
            if (needed > bufSize) {
                _mod._free(frameBuf);
                frameBuf = _mod._malloc(needed);
                bufSize  = needed;
            }
            const ret = _mod.ccall('decoder_next_frame', 'number',
                ['number','number','number','number'],
                [handle, frameBuf, dstW, dstH]);
            if (ret === 1) return null;
            if (ret < 0) throw new Error(`decoder_next_frame failed: ${ret}`);
            return new Uint8ClampedArray(_mod.HEAPU8.buffer, frameBuf, needed).slice();
        },

        close() {
            _mod._free(frameBuf);
            _mod.ccall('decoder_close', null, ['number'], [handle]);
        },
    };
}

function createDecoder(fileBytes, fmtName) {
    assertLoaded();
    const srcPtr = allocBytes(fileBytes);
    const handle = fmtName
        ? _mod.ccall('decoder_open_format', 'number',
            ['number','number','string'], [srcPtr, fileBytes.byteLength, fmtName])
        : _mod.ccall('decoder_open', 'number',
            ['number','number'], [srcPtr, fileBytes.byteLength]);
    _mod._free(srcPtr);
    if (handle < 0) throw new Error(`decoder_open failed: ${handle}`);
    return _wrapVideoDecoder(handle);
}

function createDecoderFile(path) {
    assertLoaded();
    const handle = _mod.ccall('decoder_open_file', 'number', ['string'], [path]);
    if (handle < 0) throw new Error(`decoder_open_file failed: ${handle}`);
    return _wrapVideoDecoder(handle);
}

/* ── audio decoder ───────────────────────────────────────────────────────── */

function createAudioDecoder(fileBytes, fmtName) {
    assertLoaded();
    const srcPtr = allocBytes(fileBytes);
    const handle = fmtName
        ? _mod.ccall('audio_open_format', 'number',
            ['number','number','string'], [srcPtr, fileBytes.byteLength, fmtName])
        : _mod.ccall('audio_open', 'number',
            ['number','number'], [srcPtr, fileBytes.byteLength]);
    _mod._free(srcPtr);
    if (handle < 0) throw new Error(`audio_open failed: ${handle}`);

    const channels   = _mod.ccall('audio_channels',    'number', ['number'], [handle]);
    const sampleRate = _mod.ccall('audio_sample_rate', 'number', ['number'], [handle]);

    // Pre-alloc a buffer for one typical audio frame (4096 samples * channels * 4 bytes).
    const CHUNK = 4096;
    let   cap     = CHUNK * channels;
    let   pcmBuf  = _mod._malloc(cap * 4);

    return {
        channels,
        sampleRate,

        nextSamples() {
            const ret = _mod.ccall('audio_next_samples', 'number',
                ['number','number','number'],
                [handle, pcmBuf, cap]);
            if (ret === 1) return null;
            if (ret < 0) throw new Error(`audio_next_samples failed: ${ret}`);
            if (ret > cap) {
                // Frame was larger than expected — grow and retry is not possible here;
                // the data is already written. This shouldn't happen in practice since
                // swr_convert is bounded by max_floats. Return what we got.
            }
            return new Float32Array(_mod.HEAPU8.buffer,
                pcmBuf, ret).slice();
        },

        close() {
            _mod._free(pcmBuf);
            _mod.ccall('audio_close', null, ['number'], [handle]);
        },
    };
}

/* ── probe ───────────────────────────────────────────────────────────────── */

function probe(fileBytes) {
    assertLoaded();
    const srcPtr = allocBytes(fileBytes);
    const handle = _mod.ccall('probe_open', 'number',
        ['number','number'], [srcPtr, fileBytes.byteLength]);
    _mod._free(srcPtr);
    if (handle < 0) throw new Error(`probe_open failed: ${handle}`);

    const streamCount = _mod.ccall('probe_stream_count', 'number', ['number'], [handle]);
    const streams = [];
    for (let i = 0; i < streamCount; i++) {
        const type = _mod.ccall('probe_stream_type', 'number', ['number','number'], [handle, i]);
        // AVMEDIA_TYPE_VIDEO=0, AUDIO=1, DATA=2, SUBTITLE=3, ATTACHMENT=4
        const typeStr = ['video','audio','data','subtitle','attachment'][type] ?? 'unknown';
        streams.push({ index: i, type: typeStr });
    }

    const durationMs = _mod.ccall('probe_duration_ms', 'number', ['number'], [handle]);
    const result = {
        format:   _mod.ccall('probe_format_name', 'string', ['number'], [handle]),
        duration: durationMs >= 0 ? durationMs / 1000 : null,
        bitrate:  _mod.ccall('probe_bitrate',     'number', ['number'], [handle]),
        streams,
        video: {
            width:  _mod.ccall('probe_width',   'number', ['number'], [handle]),
            height: _mod.ccall('probe_height',  'number', ['number'], [handle]),
            fpsNum: _mod.ccall('probe_fps_num', 'number', ['number'], [handle]),
            fpsDen: _mod.ccall('probe_fps_den', 'number', ['number'], [handle]),
        },
        audio: {
            sampleRate: _mod.ccall('probe_sample_rate', 'number', ['number'], [handle]),
            channels:   _mod.ccall('probe_channels',    'number', ['number'], [handle]),
        },
    };

    _mod.ccall('probe_close', null, ['number'], [handle]);
    return result;
}

/* ── encoder ─────────────────────────────────────────────────────────────── */

/**
 * Create an encoder session.
 *
 * opts:
 *   fmt    — container format name (e.g., 'image2', 'mp4', 'webm', 'wav')
 *   codec  — encoder name (e.g., 'mjpeg', 'png', 'aac', 'opus')
 *   width  — frame width in pixels (0 for audio-only)
 *   height — frame height in pixels (0 for audio-only)
 *   fps    — frame rate as { num, den } or number (default 30)
 *   bitrate — target bitrate in bits/s (0 = codec default)
 */
function createEncoder({ fmt, codec, width = 0, height = 0, fps = 30, bitrate = 0 } = {}) {
    assertLoaded();
    if (!fmt)   throw new Error('createEncoder: fmt is required');
    if (!codec) throw new Error('createEncoder: codec is required');

    const fpsNum = typeof fps === 'object' ? fps.num : Math.round(fps);
    const fpsDen = typeof fps === 'object' ? fps.den : 1;

    const handle = _mod.ccall('encoder_open', 'number',
        ['string','string','number','number','number','number','number'],
        [fmt, codec, width, height, fpsNum, fpsDen, bitrate]);
    if (handle < 0) throw new Error(`encoder_open failed: ${handle}`);

    return {
        pushRgba(rgba, w, h, ptsMs = 0) {
            const ptr = allocBytes(rgba);
            const ret = _mod.ccall('encoder_push_rgba', 'number',
                ['number','number','number','number','number'],
                [handle, ptr, w, h, ptsMs]);
            _mod._free(ptr);
            if (ret < 0) throw new Error(`encoder_push_rgba failed: ${ret}`);
        },

        finish() {
            const ret = _mod.ccall('encoder_finish', 'number', ['number'], [handle]);
            if (ret < 0) throw new Error(`encoder_finish failed: ${ret}`);
            const ptr  = _mod.ccall('encoder_output_ptr',  'number', ['number'], [handle]);
            const size = _mod.ccall('encoder_output_size', 'number', ['number'], [handle]);
            if (!ptr || size <= 0) throw new Error('encoder produced no output');
            return new Uint8Array(_mod.HEAPU8.buffer, ptr, size).slice();
        },

        close() {
            _mod.ccall('encoder_close', null, ['number'], [handle]);
        },
    };
}

/* ── benchmarks ──────────────────────────────────────────────────────────── */

function hasWebGPU() { return _hasGPU; }

function benchGpu(srcW, srcH, dstW, dstH, iters) {
    assertLoaded();
    return _mod.ccall('bench_scale_webgpu', 'number',
        ['number','number','number','number','number'], [srcW, srcH, dstW, dstH, iters]);
}

function benchCpu(srcW, srcH, dstW, dstH, iters) {
    assertLoaded();
    return _mod.ccall('bench_scale_cpu', 'number',
        ['number','number','number','number','number'], [srcW, srcH, dstW, dstH, iters]);
}

export const gpu = {
    load, scale,
    createDecoder, createDecoderFile,
    createAudioDecoder, probe, createEncoder,
    hasWebGPU, benchGpu, benchCpu,
    get FS() { return _mod && _mod.FS; },
};
