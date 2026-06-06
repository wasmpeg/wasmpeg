/**
 * gpu — typed pipeline API backed by pipeline_run_rgba_gpu + decoder_*.
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
 */

let _mod  = null;
let _hasGPU = false;

async function load({ wasmPath } = {}) {
    if (_mod) return;

    _hasGPU = typeof navigator !== 'undefined' && !!navigator.gpu;

    const path = wasmPath ?? (
        _hasGPU
            ? new URL('../../dist/webgpu.js', import.meta.url).href
            : new URL('../../dist/cpu.js',    import.meta.url).href
    );

    const { default: factory } = await import(/* @vite-ignore */ path);
    _mod = await factory();
}

function assertLoaded() {
    if (!_mod) throw new Error('call gpu.load() first');
}

function allocBytes(buf) {
    const ptr = _mod._malloc(buf.byteLength);
    _mod.HEAPU8.set(buf, ptr);
    return ptr;
}

function scale(srcRgba, srcW, srcH, dstW, dstH, filtergraph) {
    assertLoaded();
    const fg = filtergraph ?? (_hasGPU
        ? `scale_webgpu=${dstW}:${dstH}`
        : `scale=${dstW}:${dstH}`);

    const fn = _hasGPU ? 'pipeline_run_rgba_gpu' : 'pipeline_run_rgba';
    const srcPtr = allocBytes(srcRgba);
    const dstPtr = _mod._malloc(dstW * dstH * 4);

    const ret = _mod.ccall(fn, 'number',
        ['number','number','number','number','number','number','string'],
        [srcPtr, srcW, srcH, dstPtr, dstW, dstH, fg]);

    const out = ret === 0
        ? new Uint8ClampedArray(_mod.HEAPU8.buffer, dstPtr, dstW * dstH * 4).slice()
        : null;
    _mod._free(srcPtr);
    _mod._free(dstPtr);
    if (ret !== 0) throw new Error(`scale failed: ${ret}`);
    return out;
}

function createDecoder(fileBytes) {
    assertLoaded();
    const srcPtr = allocBytes(fileBytes);
    const handle = _mod.ccall('decoder_open', 'number',
        ['number','number'], [srcPtr, fileBytes.byteLength]);
    _mod._free(srcPtr);
    if (handle < 0) throw new Error(`decoder_open failed: ${handle}`);

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

export const gpu = { load, scale, createDecoder, hasWebGPU, benchGpu, benchCpu };
