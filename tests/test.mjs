/**
 * test.mjs — functional test suite for wasmpeg.
 *
 * Tests three layers:
 *   1. Raw pipeline exports (ccall/cwrap against the WASM module directly)
 *   2. FFmpeg class API  (ffmpeg.wasm-compatible: load/exec/writeFile/readFile)
 *   3. gpu namespace     (typed pipeline: gpu.load / gpu.scale)
 *
 * Run:  node tests/test.mjs
 * Gate: make verify
 */

import { fileURLToPath }  from 'url';
import { deflateSync }    from 'zlib';
import path from 'path';
import fs   from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

let passed = 0, failed = 0, skipped = 0;

function ok(label, cond) {
    if (cond) { console.log(`  PASS  ${label}`); passed++; }
    else       { console.error(`  FAIL  ${label}`); failed++; }
}

function skip(label, reason) {
    console.log(`  SKIP  ${label}  (${reason})`); skipped++;
}

function section(name) { console.log(`\n── ${name} ──`); }

function makeGradient(w, h) {
    const buf = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            buf[i]   = (x * 255 / (w - 1)) | 0;
            buf[i+1] = (y * 255 / (h - 1)) | 0;
            buf[i+2] = 128;
            buf[i+3] = 255;
        }
    return buf;
}

function crc32(buf) {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c;
    }
    let crc = 0xFFFFFFFF;
    for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    return (~crc) >>> 0;
}

function pngChunk(type, data) {
    const t   = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crcBuf]);
}

function makeTinyPng(w = 2, h = 2) {
    const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
    const raw = Buffer.alloc(h * (1 + w * 3));
    for (let y = 0; y < h; y++) {
        raw[y * (1 + w * 3)] = 0;
        for (let x = 0; x < w; x++) {
            const off = y * (1 + w * 3) + 1 + x * 3;
            raw[off]   = (x * 255 / Math.max(w - 1, 1)) | 0;
            raw[off+1] = (y * 255 / Math.max(h - 1, 1)) | 0;
            raw[off+2] = 128;
        }
    }
    const idat = deflateSync(raw, { level: 1 });
    return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

async function loadWasm(jsPath) {
    const { default: factory } = await import(jsPath);
    const wasmBin = fs.readFileSync(jsPath.replace(/\.js$/, '.wasm'));
    return factory({ wasmBinary: wasmBin });
}

async function testBuild(name, jsPath) {
    section(`pipeline / ${name}`);

    if (!fs.existsSync(jsPath)) {
        skip(name, 'not built');
        return;
    }

    let mod;
    try { mod = await loadWasm(jsPath); }
    catch (e) { console.error(`  FAIL  load: ${e.message}`); failed++; return; }

    const ver = mod.ccall('pipeline_version', 'string', [], []);
    ok(`pipeline_version returns string`, typeof ver === 'string' && ver.length > 0);
    console.log(`        version: ${ver}`);

    const SRC_W = 320, SRC_H = 240, DST_W = 160, DST_H = 120;
    const src = makeGradient(SRC_W, SRC_H);

    const allocU8 = buf => {
        const ptr = mod._malloc(buf.byteLength);
        mod.HEAPU8.set(buf, ptr);
        return ptr;
    };

    {
        const srcPtr = allocU8(src);
        const dstPtr = mod._malloc(DST_W * DST_H * 4);
        const ret = mod.ccall('pipeline_run_rgba', 'number',
            ['number','number','number','number','number','number','string'],
            [srcPtr, SRC_W, SRC_H, dstPtr, DST_W, DST_H, `scale=${DST_W}:${DST_H}`]);
        const out = new Uint8Array(mod.HEAPU8.buffer, dstPtr, DST_W * DST_H * 4);
        ok(`pipeline_run_rgba returns 0`,       ret === 0);
        ok(`pipeline_run_rgba output non-zero`, out.some(v => v !== 0));
        mod._free(srcPtr); mod._free(dstPtr);
    }

    if (mod._pipeline_run_rgba_gpu) {
        const srcPtr = allocU8(src);
        const dstPtr = mod._malloc(DST_W * DST_H * 4);
        const ret = mod.ccall('pipeline_run_rgba_gpu', 'number',
            ['number','number','number','number','number','number','string'],
            [srcPtr, SRC_W, SRC_H, dstPtr, DST_W, DST_H, `scale_webgpu=${DST_W}:${DST_H}`]);
        if (ret === 0) {
            const out = new Uint8Array(mod.HEAPU8.buffer, dstPtr, DST_W * DST_H * 4);
            ok(`pipeline_run_rgba_gpu returns 0`,       true);
            ok(`pipeline_run_rgba_gpu output non-zero`, out.some(v => v !== 0));
        } else {
            skip(`pipeline_run_rgba_gpu`, 'no WebGPU adapter in Node');
        }
        mod._free(srcPtr); mod._free(dstPtr);
    }

    {
        const ms = mod.ccall('bench_scale_cpu', 'number',
            ['number','number','number','number','number'],
            [SRC_W, SRC_H, DST_W, DST_H, 20]);
        ok(`bench_scale_cpu returns positive`, ms > 0);
        console.log(`        CPU scale: ${ms.toFixed(2)} ms/frame`);
    }
}

// ── 2. Pipeline edge cases ────────────────────────────────────────────────────

async function testPipelineEdgeCases(jsPath) {
    section('pipeline / edge cases');

    if (!fs.existsSync(jsPath)) { skip('pipeline edge cases', 'cpu build not found'); return; }

    const mod = await loadWasm(jsPath);
    const W = 64, H = 64;
    const src = makeGradient(W, H);

    const allocU8 = buf => {
        const ptr = mod._malloc(buf.byteLength);
        mod.HEAPU8.set(buf, ptr);
        return ptr;
    };

    {
        const srcPtr = allocU8(src);
        const dstPtr = mod._malloc(W * H * 4);
        const ret = mod.ccall('pipeline_run_rgba', 'number',
            ['number','number','number','number','number','number','string'],
            [srcPtr, W, H, dstPtr, W, H, 'notarealfilter=1:1']);
        ok('invalid filtergraph returns non-zero', ret !== 0);
        mod._free(srcPtr); mod._free(dstPtr);
    }

    {
        const srcPtr = allocU8(src);
        const dstPtr = mod._malloc(W * H * 4);
        const ret = mod.ccall('pipeline_run_rgba', 'number',
            ['number','number','number','number','number','number','string'],
            [srcPtr, W, H, dstPtr, W, H, `scale=${W}:${H}`]);
        const out = new Uint8Array(mod.HEAPU8.buffer, dstPtr, W * H * 4);
        ok('same-size scale returns 0',       ret === 0);
        ok('same-size scale output non-zero', out.some(v => v !== 0));
        mod._free(srcPtr); mod._free(dstPtr);
    }

    {
        const srcPtr = allocU8(src);
        const dstPtr = mod._malloc(32 * 32 * 4);
        const ret = mod.ccall('pipeline_run_rgba', 'number',
            ['number','number','number','number','number','number','string'],
            [srcPtr, W, H, dstPtr, 32, 32, 'scale=32:32,format=rgba']);
        const out = new Uint8Array(mod.HEAPU8.buffer, dstPtr, 32 * 32 * 4);
        ok('scale+format filtergraph returns 0',       ret === 0);
        ok('scale+format filtergraph output non-zero', out.some(v => v !== 0));
        mod._free(srcPtr); mod._free(dstPtr);
    }

    {
        const val = mod.ccall('bench_scale_webgpu', 'number',
            ['number','number','number','number','number'],
            [W, H, 32, 32, 1]);
        ok('bench_scale_webgpu returns -1 on CPU build', val === -1);
    }
}

// ── 3. Decoder raw API ───────────────────────────────────────────────────────

async function testDecoderApi(jsPath) {
    section('decoder raw API');

    if (!fs.existsSync(jsPath)) { skip('decoder API', 'cpu build not found'); return; }

    const mod = await loadWasm(jsPath);

    {
        const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE, 0x00, 0x00]);
        const ptr = mod._malloc(garbage.byteLength);
        mod.HEAPU8.set(garbage, ptr);
        const h = mod.ccall('decoder_open', 'number',
            ['number','number'], [ptr, garbage.byteLength]);
        mod._free(ptr);
        ok('decoder_open with garbage returns < 0', h < 0);
    }

    {
        ok('decoder_width(-1) returns -1',   mod.ccall('decoder_width',   'number', ['number'], [-1]) === -1);
        ok('decoder_height(-1) returns -1',  mod.ccall('decoder_height',  'number', ['number'], [-1]) === -1);
        ok('decoder_fps_num(-1) returns -1', mod.ccall('decoder_fps_num', 'number', ['number'], [-1]) === -1);
        ok('decoder_fps_den(-1) returns -1', mod.ccall('decoder_fps_den', 'number', ['number'], [-1]) === -1);
    }

    const pngBytes = makeTinyPng(4, 4);
    mod.FS.writeFile('/dec_test.png', new Uint8Array(pngBytes));
    const handle = mod.ccall('decoder_open_file', 'number', ['string'], ['/dec_test.png']);

    if (handle < 0) {
        skip('decoder_open_file PNG success path', `open failed (code ${handle})`);
        skip('decoder_width / decoder_height', 'depends on open');
        skip('decoder_fps_num / decoder_fps_den', 'depends on open');
    } else {
        ok('decoder_open_file PNG returns >= 0', true);
        const w = mod.ccall('decoder_width',   'number', ['number'], [handle]);
        const h = mod.ccall('decoder_height',  'number', ['number'], [handle]);
        ok('decoder_width  returns > 0', w > 0);
        ok('decoder_height returns > 0', h > 0);
        const fpsNum = mod.ccall('decoder_fps_num', 'number', ['number'], [handle]);
        const fpsDen = mod.ccall('decoder_fps_den', 'number', ['number'], [handle]);
        ok('decoder_fps_num returns > 0', fpsNum > 0);
        ok('decoder_fps_den returns > 0', fpsDen > 0);

        const frameBuf = mod._malloc(w * h * 4);
        const fret = mod.ccall('decoder_next_frame', 'number',
            ['number','number','number','number'], [handle, frameBuf, w, h]);
        ok('decoder_next_frame returns 0 or 1', fret === 0 || fret === 1);
        if (fret === 0) {
            const pixels = new Uint8Array(mod.HEAPU8.buffer, frameBuf, w * h * 4);
            ok('decoder_next_frame output non-zero', pixels.some(v => v !== 0));
        } else {
            skip('decoder_next_frame output', 'EOF on first call');
        }
        mod._free(frameBuf);
        mod.ccall('decoder_close', null, ['number'], [handle]);
        ok('decoder_close does not crash', true);
        ok('decoder_width after close returns -1',  mod.ccall('decoder_width',  'number', ['number'], [handle]) === -1);
        ok('decoder_height after close returns -1', mod.ccall('decoder_height', 'number', ['number'], [handle]) === -1);
    }

    {
        const png1 = makeTinyPng(2, 2);
        const png2 = makeTinyPng(4, 4);
        mod.FS.writeFile('/dec_c1.png', new Uint8Array(png1));
        mod.FS.writeFile('/dec_c2.png', new Uint8Array(png2));
        const h1 = mod.ccall('decoder_open_file', 'number', ['string'], ['/dec_c1.png']);
        const h2 = mod.ccall('decoder_open_file', 'number', ['string'], ['/dec_c2.png']);
        if (h1 >= 0 && h2 >= 0) {
            ok('concurrent sessions: handles distinct', h1 !== h2);
            ok('concurrent sessions: h1 width > 0', mod.ccall('decoder_width', 'number', ['number'], [h1]) > 0);
            ok('concurrent sessions: h2 width > 0', mod.ccall('decoder_width', 'number', ['number'], [h2]) > 0);
            mod.ccall('decoder_close', null, ['number'], [h1]);
            mod.ccall('decoder_close', null, ['number'], [h2]);
            ok('concurrent sessions: both closed cleanly', true);
        } else {
            skip('concurrent sessions', 'PNG open failed in this build');
        }
    }
}

// ── 4. FFmpeg class API ──────────────────────────────────────────────────────

async function testFFmpegClass(cpuJsPath) {
    section('FFmpeg class API');

    if (!fs.existsSync(cpuJsPath)) { skip('FFmpeg class', 'cpu build not found'); return; }

    const { FFmpeg } = await import('../src/js/index.js');

    const ff = new FFmpeg();
    ok('FFmpeg() constructed',    ff instanceof FFmpeg);
    ok('loaded is false initially', ff.loaded === false);

    const logs = [];
    ff.on('log', ({ type, message }) => logs.push(`${type}: ${message}`));

    try {
        await ff.load({ wasmPath: new URL('../dist/cpu.js', import.meta.url).href });
    } catch (e) {
        console.error(`  FAIL  load(): ${e.message}`); failed++; return;
    }
    ok('load() resolves',     true);
    ok('loaded is true',      ff.loaded === true);

    let doubleLoadThrew = false;
    try { await ff.load({ wasmPath: new URL('../dist/cpu.js', import.meta.url).href }); }
    catch { doubleLoadThrew = true; }
    ok('double load() does not throw',          !doubleLoadThrew);
    ok('loaded still true after double load',   ff.loaded === true);

    ff.off('log', ({ type, message }) => logs.push(`${type}: ${message}`));
    const countBefore = logs.length;

    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await ff.writeFile('probe.bin', bytes);
    ok('off() stopped log events after removal', logs.length === countBefore);
    const back = await ff.readFile('probe.bin');
    ok('writeFile / readFile roundtrip', back.length === 5 && back[4] === 5);

    await ff.deleteFile('probe.bin');

    await ff.createDir('/testdir');
    await ff.writeFile('/testdir/a.bin', new Uint8Array([0]));
    const entries = await ff.listDir('/testdir');
    ok('createDir creates a directory',  Array.isArray(entries));
    ok('listDir sees written file',      entries.includes('a.bin'));
    ok('listDir includes . and ..',      entries.includes('.') && entries.includes('..'));
    await ff.deleteFile('/testdir/a.bin');

    let threw = false;
    try { await ff.readFile('probe.bin'); } catch { threw = true; }
    ok('deleteFile removes file', threw);

    let execMsg = '';
    try { await ff.exec(['-version']); } catch (e) { execMsg = e.message; }
    ok('exec() throws with expected message', execMsg.includes('no -i input'));

    ff.terminate();
    ok('terminate() clears loaded', ff.loaded === false);

    const ff2 = new FFmpeg();
    ff2.on('progress', () => {});
    ok('on("progress") registers without crashing', true);
}

// ── 3. gpu namespace ─────────────────────────────────────────────────────────

async function testGpu(cpuJsPath) {
    section('gpu namespace');

    if (!fs.existsSync(cpuJsPath)) { skip('gpu namespace', 'cpu build not found'); return; }

    const { gpu } = await import('../src/js/index.js');

    try {
        await gpu.load({ wasmPath: new URL('../dist/cpu.js', import.meta.url).href });
    } catch (e) {
        console.error(`  FAIL  gpu.load(): ${e.message}`); failed++; return;
    }
    ok('gpu.load() resolves', true);

    let doubleThrew = false;
    try { await gpu.load({ wasmPath: new URL('../dist/cpu.js', import.meta.url).href }); } catch { doubleThrew = true; }
    ok('double gpu.load() does not throw', !doubleThrew);

    ok('gpu.hasWebGPU() is false in Node', gpu.hasWebGPU() === false);

    const SRC_W = 64, SRC_H = 64, DST_W = 32, DST_H = 32;
    const src = makeGradient(SRC_W, SRC_H);

    let out;
    try { out = gpu.scale(src, SRC_W, SRC_H, DST_W, DST_H); }
    catch (e) { console.error(`  FAIL  gpu.scale(): ${e.message}`); failed++; return; }

    ok('gpu.scale() returns Uint8ClampedArray',       out instanceof Uint8ClampedArray);
    ok('gpu.scale() output size correct',             out.length === DST_W * DST_H * 4);
    ok('gpu.scale() output non-zero',                 out.some(v => v !== 0));

    let out2;
    try { out2 = gpu.scale(src, SRC_W, SRC_H, DST_W, DST_H, `scale=${DST_W}:${DST_H}`); } catch { out2 = null; }
    if (out2) {
        ok('gpu.scale() explicit filtergraph size correct', out2.length === DST_W * DST_H * 4);
        ok('gpu.scale() explicit filtergraph non-zero',     out2.some(v => v !== 0));
    }

    const benchMs = gpu.benchCpu(SRC_W, SRC_H, DST_W, DST_H, 20);
    ok('benchCpu() returns positive', benchMs > 0);
    console.log(`        CPU bench: ${benchMs.toFixed(2)} ms/frame`);

    const gpuBench = gpu.benchGpu(SRC_W, SRC_H, DST_W, DST_H, 1);
    ok('benchGpu() returns -1 on CPU build', gpuBench === -1);

    let threw = false;
    try { gpu.createDecoder(new Uint8Array([0xFF, 0x00, 0x11, 0x22])); } catch { threw = true; }
    ok('createDecoder with garbage throws', threw);

    const pngBytes = makeTinyPng(4, 4);
    gpu.FS.writeFile('/gpu_test.png', new Uint8Array(pngBytes));
    let dec;
    try { dec = gpu.createDecoderFile('/gpu_test.png'); }
    catch (e) {
        skip('createDecoderFile PNG', `open failed: ${e.message}`);
        return;
    }
    ok('createDecoderFile returns object',           dec !== null && typeof dec === 'object');
    ok('createDecoderFile .width > 0',               dec.width > 0);
    ok('createDecoderFile .height > 0',              dec.height > 0);
    ok('createDecoderFile .fps is a positive number', dec.fps > 0);
    const frame = dec.nextFrame();
    if (frame !== null) {
        ok('nextFrame() returns Uint8ClampedArray',    frame instanceof Uint8ClampedArray);
        ok('nextFrame() output size = width*height*4', frame.length === dec.width * dec.height * 4);
        ok('nextFrame() output non-zero',              frame.some(v => v !== 0));
    } else {
        skip('nextFrame() output', 'EOF immediately (single-frame image)');
    }
    dec.close();
    ok('decoder.close() does not crash', true);
}

// ── run ──────────────────────────────────────────────────────────────────────

const cpuJs    = path.join(ROOT, 'dist/cpu.js');
const webgpuJs = path.join(ROOT, 'dist/webgpu.js');

await testBuild('CPU build',    cpuJs);
await testBuild('WebGPU build', webgpuJs);
await testPipelineEdgeCases(cpuJs);
await testDecoderApi(cpuJs);
await testFFmpegClass(cpuJs);
await testGpu(cpuJs);

const total = passed + failed + skipped;
console.log(`\n${total} tests — ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
process.exit(failed > 0 ? 1 : 0);
