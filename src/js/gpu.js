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
const _logHandlers = new Set();

/** Subscribe to the module's stdout/stderr. Handlers get ({ type, message }). */
function onLog(fn)  { _logHandlers.add(fn);    return () => _logHandlers.delete(fn); }
function offLog(fn) { _logHandlers.delete(fn); }

function emitLog(type, message) {
    for (const h of _logHandlers) h({ type, message });
}

async function instantiate(path) {
    const isNode = typeof process !== 'undefined' && process.versions?.node;
    let nodeOpts = {};
    if (isNode) {
        const { default: fsMod } = await import('node:fs');
        nodeOpts = { wasmBinary: fsMod.readFileSync(new URL(path).pathname.replace(/\.js$/, '.wasm')) };
    }
    const { default: factory } = await import(/* @vite-ignore */ path);
    return factory({
        print:    msg => emitLog('stdout', msg),
        printErr: msg => emitLog('stderr', msg),
        ...nodeOpts,
    });
}

async function load({ wasmPath } = {}) {
    if (_mod) return;

    _hasGPU = typeof navigator !== 'undefined' && !!navigator.gpu;

    if (wasmPath) { _mod = await instantiate(wasmPath); return; }

    if (_hasGPU) {
        // The WebGPU binary is optional — a package may ship CPU-only. Falling
        // back keeps load() working in exactly the browsers we target, instead
        // of failing on a missing artifact. Clearing the flag matters: the CPU
        // build does not export pipeline_run_rgba_gpu.
        try {
            _mod = await instantiate(new URL('../../dist/webgpu.js', import.meta.url).href);
            return;
        } catch {
            _hasGPU = false;
        }
    }

    _mod = await instantiate(new URL('../../dist/cpu.js', import.meta.url).href);
}

function assertLoaded() {
    if (!_mod) throw new Error('call gpu.load() first');
}

function allocBytes(buf) {
    const ptr = _mod._malloc(buf.byteLength);
    _mod.HEAPU8.set(buf, ptr);
    return ptr;
}

// pipeline_run_rgba_gpu / gpu_session_open / bench_scale_webgpu* create a
// WebGPU device under the hood, which is inherently async. Under ASYNCIFY, a
// wasm call that yields makes its ccall wrapper return a Promise instead of
// its declared number — every caller here still treats the result as
// synchronous, so a raw Promise would otherwise sail past a `< 0` check
// (always false) and get used as a handle/return value, surfacing as a
// baffling downstream failure instead of pointing at the real cause. This is
// a guard, not a fix: the real fix needs either an async GPU-path API or a
// synchronous device-warm step on the C side.
function assertSyncResult(value, fnName) {
    if (value instanceof Promise) {
        throw new Error(
            `${fnName}() returned a Promise instead of a number — WebGPU device ` +
            `creation is async under ASYNCIFY and this call path expects a ` +
            `synchronous result. The GPU scale path does not work yet with a ` +
            `real WebGPU adapter present; use the CPU build/fallback instead.`
        );
    }
    return value;
}

/* ── persistent GPU session ──────────────────────────────────────────────── */

/**
 * Open a reusable GPU filter session.
 *
 * The WebGPU device, hardware frame pool and filtergraph are built once and
 * reused for every run(). Creating a device costs two async round trips, so
 * per-call creation dominates the actual filtering work — open a session when
 * you are filtering more than one frame at the same size.
 *
 * Returns { run(rgba) -> Uint8ClampedArray, close() }.
 */
function createGpuSession({ srcW, srcH, dstW, dstH, filtergraph } = {}) {
    assertLoaded();
    if (!_hasGPU) throw new Error('createGpuSession requires the WebGPU build');
    if (!srcW || !srcH || !dstW || !dstH) throw new Error('createGpuSession: sizes are required');

    const fg = filtergraph ?? `scale_webgpu=${dstW}:${dstH}`;
    const handle = assertSyncResult(_mod.ccall('gpu_session_open', 'number',
        ['number','number','number','number','string'], [srcW, srcH, dstW, dstH, fg]), 'gpu_session_open');
    if (handle < 0) throw new Error(`gpu_session_open failed: ${handle}`);

    const srcBytes = srcW * srcH * 4;
    const dstBytes = dstW * dstH * 4;
    const srcPtr = _mod._malloc(srcBytes);
    const dstPtr = _mod._malloc(dstBytes);

    let closed = false;
    return {
        srcW, srcH, dstW, dstH, filtergraph: fg,
        run(rgba) {
            if (closed) throw new Error('gpu session is closed');
            _mod.HEAPU8.set(rgba, srcPtr);
            const ret = assertSyncResult(_mod.ccall('gpu_session_run', 'number',
                ['number','number','number'], [handle, srcPtr, dstPtr]), 'gpu_session_run');
            if (ret !== 0) throw new Error(`gpu_session_run failed: ${ret}`);
            return new Uint8ClampedArray(_mod.HEAPU8.buffer, dstPtr, dstBytes).slice();
        },
        close() {
            if (closed) return;
            closed = true;
            _mod._free(srcPtr);
            _mod._free(dstPtr);
            _mod.ccall('gpu_session_close', null, ['number'], [handle]);
        },
    };
}

// scale() is stateless, but callers almost always run the same geometry in a
// loop. Hold one session and reuse it while the parameters match.
let _cached = null;

function _releaseCached() {
    if (_cached) { try { _cached.close(); } catch { /* already gone */ } _cached = null; }
}

/* ── video scale ─────────────────────────────────────────────────────────── */

function scale(srcRgba, srcW, srcH, dstW, dstH, filtergraph) {
    assertLoaded();
    const fg = filtergraph ?? (_hasGPU
        ? `scale_webgpu=${dstW}:${dstH}`
        : `scale=${dstW}:${dstH}`);

    if (_hasGPU) {
        if (!_cached || _cached.srcW !== srcW || _cached.srcH !== srcH ||
            _cached.dstW !== dstW || _cached.dstH !== dstH || _cached.filtergraph !== fg) {
            _releaseCached();
            try {
                _cached = createGpuSession({ srcW, srcH, dstW, dstH, filtergraph: fg });
            } catch {
                _cached = null;   // fall through to the per-call path below
            }
        }
        if (_cached) return _cached.run(srcRgba);
    }

    const fn     = _hasGPU ? 'pipeline_run_rgba_gpu' : 'pipeline_run_rgba';
    const srcPtr = allocBytes(srcRgba);
    const dstPtr = _mod._malloc(dstW * dstH * 4);

    // Free in a finally: an abort inside the filtergraph would otherwise leak
    // both buffers, and a filter op is easy to call in a loop.
    try {
        const ret = assertSyncResult(_mod.ccall(fn, 'number',
            ['number','number','number','number','number','number','string'],
            [srcPtr, srcW, srcH, dstPtr, dstW, dstH, fg]), fn);
        if (ret !== 0) throw new Error(`scale failed: ${ret}`);
        return new Uint8ClampedArray(_mod.HEAPU8.buffer, dstPtr, dstW * dstH * 4).slice();
    } finally {
        _mod._free(srcPtr);
        _mod._free(dstPtr);
    }
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

        /**
         * Seek to `ms` from the start of the video stream.
         *
         * Lands on the nearest keyframe at or before the target, so the next
         * frame may be earlier than requested. Container seek, not frame exact.
         * A negative target clamps to the start.
         */
        seek(ms) {
            const ret = _mod.ccall('decoder_seek', 'number',
                ['number','number'], [handle, Math.max(0, Math.round(ms))]);
            if (ret < 0) throw new Error(`decoder_seek failed: ${ret}`);
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
            return new Float32Array(_mod.HEAPU8.buffer, pcmBuf, ret).slice();
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
    return assertSyncResult(_mod.ccall('bench_scale_webgpu', 'number',
        ['number','number','number','number','number'], [srcW, srcH, dstW, dstH, iters]), 'bench_scale_webgpu');
}

function benchGpuSession(srcW, srcH, dstW, dstH, iters) {
    assertLoaded();
    return assertSyncResult(_mod.ccall('bench_scale_webgpu_session', 'number',
        ['number','number','number','number','number'], [srcW, srcH, dstW, dstH, iters]), 'bench_scale_webgpu_session');
}

function benchCpu(srcW, srcH, dstW, dstH, iters) {
    assertLoaded();
    return _mod.ccall('bench_scale_cpu', 'number',
        ['number','number','number','number','number'], [srcW, srcH, dstW, dstH, iters]);
}

/**
 * Open an audio encoder.
 *
 * Input is interleaved Float32 at `sampleRate`/`channels` — the same layout
 * createAudioDecoder() yields, so a decode/encode round trip needs no
 * conversion here.
 *
 * Returns { pushPcm(f32), finish() -> Uint8Array, close() }.
 */
function createAudioEncoder({ fmt, codec, sampleRate, channels, bitrate = 0 } = {}) {
    assertLoaded();
    if (!fmt)   throw new Error('createAudioEncoder: fmt is required');
    if (!codec) throw new Error('createAudioEncoder: codec is required');
    if (!sampleRate || !channels) throw new Error('createAudioEncoder: sampleRate and channels are required');

    const handle = _mod.ccall('encoder_open_audio', 'number',
        ['string','string','number','number','number'],
        [fmt, codec, sampleRate, channels, bitrate]);
    if (handle < 0) throw new Error(`encoder_open_audio failed: ${handle}`);

    let buf = 0, bufFloats = 0;
    let closed = false;

    return {
        pushPcm(samples) {
            if (closed) throw new Error('audio encoder is closed');
            const f32 = samples instanceof Float32Array ? samples : Float32Array.from(samples);
            if (f32.length > bufFloats) {
                if (buf) _mod._free(buf);
                buf = _mod._malloc(f32.length * 4);
                bufFloats = f32.length;
            }
            _mod.HEAPU8.set(new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength), buf);
            const ret = _mod.ccall('encoder_push_pcm', 'number',
                ['number','number','number'], [handle, buf, f32.length]);
            if (ret < 0) throw new Error(`encoder_push_pcm failed: ${ret}`);
        },
        finish() {
            if (closed) throw new Error('audio encoder is closed');
            const ret = _mod.ccall('encoder_finish', 'number', ['number'], [handle]);
            if (ret < 0) throw new Error(`encoder_finish failed: ${ret}`);
            const size = _mod.ccall('encoder_output_size', 'number', ['number'], [handle]);
            const ptr  = _mod.ccall('encoder_output_ptr',  'number', ['number'], [handle]);
            return new Uint8Array(_mod.HEAPU8.buffer, ptr, size).slice();
        },
        close() {
            if (closed) return;
            closed = true;
            if (buf) _mod._free(buf);
            _mod.ccall('encoder_close', null, ['number'], [handle]);
        },
    };
}

export const gpu = {
    load, scale, onLog, offLog,
    createGpuSession, releaseCachedSession: _releaseCached,
    benchGpuSession,
    createDecoder, createDecoderFile,
    createAudioDecoder, probe, createEncoder, createAudioEncoder,
    hasWebGPU, benchGpu, benchCpu,
    get FS() { return _mod && _mod.FS; },
};
