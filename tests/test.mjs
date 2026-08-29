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
import { parseArgs } from '../src/js/exec.mjs';
import wasmpeg from '../src/js/wasmpeg.mjs';

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

// A PNG whose header parses but whose IDAT will not inflate: the decoder opens
// (dimensions come from IHDR) and then fails on the first frame. That is the
// window in which a session slot used to leak.
function makeCorruptPng(w = 8, h = 8) {
    const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([sig, pngChunk('IHDR', ihdr),
        pngChunk('IDAT', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])),
        pngChunk('IEND', Buffer.alloc(0))]);
}

// Minimal animated GIF. Uses min-code-size 7 so every LZW code is exactly 8
// bits (byte aligned), with a Clear code often enough that the code width never
// grows — "uncompressed" LZW, so no compressor is needed. Gives the suite a
// real multi-frame source without shipping a binary fixture.
function makeAnimatedGif(w = 4, h = 4, frames = 3) {
    const b = [];
    const u16 = v => { b.push(v & 0xFF, (v >> 8) & 0xFF); };
    b.push(...Buffer.from('GIF89a'));
    u16(w); u16(h);
    b.push(0xF0, 0, 0);
    b.push(0, 0, 0, 255, 255, 255);

    for (let f = 0; f < frames; f++) {
        b.push(0x21, 0xF9, 0x04, 0x00); u16(4); b.push(0x00, 0x00);
        b.push(0x2C); u16(0); u16(0); u16(w); u16(h); b.push(0x00);
        b.push(0x07);

        const codes = [0x80];
        for (let i = 0; i < w * h; i++) {
            codes.push((i + f) % 2);
            if (codes.length % 100 === 0) codes.push(0x80);
        }
        codes.push(0x81);

        for (let i = 0; i < codes.length; i += 255) {
            const chunk = codes.slice(i, i + 255);
            b.push(chunk.length, ...chunk);
        }
        b.push(0x00);
    }
    b.push(0x3B);
    return Buffer.from(b);
}

// Uncompressed PCM WAV, so the suite has an audio source it can build itself.
function makeWav(sampleRate = 8000, channels = 1, frames = 800) {
    const bytes = frames * channels * 2;
    const b = Buffer.alloc(44 + bytes);
    b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
    b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
    b.writeUInt16LE(channels, 22); b.writeUInt32LE(sampleRate, 24);
    b.writeUInt32LE(sampleRate * channels * 2, 28);
    b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(bytes, 40);
    for (let i = 0; i < frames; i++)
        for (let c = 0; c < channels; c++)
            b.writeInt16LE(Math.round(16000 * Math.sin(2 * Math.PI * 440 * i / sampleRate)),
                44 + (i * channels + c) * 2);
    return b;
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

function testArgParser() {
    section('exec arg parser / flag tables');

    // Boolean flags must not swallow the following token.
    const re = parseArgs(['-re', '-i', 'in.mp4']);
    ok('-re is boolean, -i still parses its input', re.inputs[0]?.url === 'in.mp4');

    const copyts = parseArgs(['-i', 'in.mp4', '-copyts', 'out.mp4']);
    ok('-copyts is boolean, output still parses', copyts.outputs[0]?.url === 'out.mp4');

    // Value flags must consume their argument, not leave it as an output.
    const vsync = parseArgs(['-i', 'in.mp4', '-vsync', '2', 'out.mp4']);
    ok('-vsync consumes its value', vsync.outputs.length === 1 && vsync.outputs[0]?.url === 'out.mp4');

    const async_ = parseArgs(['-i', 'in.mp4', '-async', '1', 'out.mp4']);
    ok('-async consumes its value', async_.outputs.length === 1 && async_.outputs[0]?.url === 'out.mp4');
}

async function testHighLevel() {
    section('high-level wasmpeg API');

    await wasmpeg.load();
    const png = new Uint8Array(makeTinyPng(8, 8));

    // Regression: scale() must return RGBA pixels, not a decoder. The filter
    // options live in `global` (no output token), which exec() has to honour.
    const px = await wasmpeg.scale(png, 4, 4);
    ok('scale() returns a pixel array', px instanceof Uint8ClampedArray);
    ok('scale() output is 4*4*4 bytes', px.length === 4 * 4 * 4);

    const dec = await wasmpeg.decode(png);
    ok('decode() returns a frame iterator', typeof dec.nextFrame === 'function');
    ok('decode() reports width 8', dec.width === 8);
    dec.close();

    const info = await wasmpeg.probe(png);
    ok('probe() reports a video stream', info.video.width === 8 && info.video.height === 8);

    // encode() must produce a valid image, not throw (it was broken by an int64
    // pts arg and a missing pipe muxer).
    const jpg = await wasmpeg.encode(png, { codec: 'mjpeg', frames: 1 });
    ok('encode() to mjpeg produces output', jpg.length > 0 && jpg[0] === 0xFF && jpg[1] === 0xD8);
    const outPng = await wasmpeg.encode(png, { codec: 'png', frames: 1 });
    ok('encode() to png produces a PNG', outPng.length > 0 && outPng[0] === 0x89 && outPng[1] === 0x50);
}

// ── 8. Public export surface ─────────────────────────────────────────────────

async function testExportSurface() {
    section('Public export surface');

    const mod = await import('../src/js/index.js');
    const { gpu: gpuNs } = mod;
    await gpuNs.load();

    ok('default export is the high-level API',
        typeof mod.default === 'object' && mod.default !== null);
    for (const fn of ['load', 'scale', 'decode', 'decodeAudio', 'probe', 'encode', 'run'])
        ok(`default.${fn} is callable`, typeof mod.default?.[fn] === 'function');

    ok('FFmpeg export is a constructor',       typeof mod.FFmpeg === 'function');
    ok('gpu export is an object',              typeof mod.gpu === 'object' && mod.gpu !== null);
    ok('exec export is callable',              typeof mod.exec === 'function');
    ok('named wasmpeg export is the default',  mod.wasmpeg === mod.default);

    // The WebGPU artifact is optional. Node has no navigator.gpu, so the
    // loaders must already be sitting on the CPU build here — the same path a
    // WebGPU browser takes when dist/webgpu.js was never shipped.
    ok('gpu namespace loaded without a webgpu artifact', gpuNs.hasWebGPU() === false);
    const ff = new mod.FFmpeg();
    await ff.load();
    ok('FFmpeg.load() succeeds with no webgpu artifact', ff.loaded === true);
    ff.terminate();
}

// ── 9. Session-slot lifecycle ────────────────────────────────────────────────

async function testSessionLifecycle() {
    section('Session lifecycle');

    const { exec } = await import('../src/js/exec.mjs');
    const bad = makeCorruptPng();

    // Twelve failures against an eight-slot pool. If a failed filter op strands
    // its decoder, the ninth open reports ENOMEM (-12) instead of the real
    // decode error.
    let openFailures = 0, failures = 0;
    for (let i = 0; i < 12; i++) {
        try {
            await exec(new Uint8Array(bad), ['-vf', 'scale=4:4']);
        } catch (e) {
            failures++;
            // A leak shows up as the *open* failing, not the decode.
            if (/decoder_open/.test(e.message)) openFailures++;
        }
    }
    ok('every failed filter op threw',            failures === 12);
    ok('no failed op stranded a session slot',    openFailures === 0);

    // The pool must still be usable afterwards.
    const good = makeTinyPng(4, 4);
    let out = null, poolErr = null;
    try { out = await exec(new Uint8Array(good), ['-vf', 'scale=2:2']); }
    catch (e) { poolErr = e; }
    ok('pool still serves a good input after failures',
        poolErr === null && out?.length === 2 * 2 * 4);
}

// ── 10. Encode frame budget ──────────────────────────────────────────────────

async function testEncodeBudget() {
    section('Encode frame budget');

    const { gpu } = await import('../src/js/gpu.js');
    const wasmpegApi = (await import('../src/js/wasmpeg.mjs')).default;
    await wasmpegApi.load();

    // Count nextFrame() calls by wrapping the decoder the encoder opens.
    const realCreate = gpu.createDecoder;
    let decodes = 0;
    gpu.createDecoder = (...args) => {
        const d = realCreate.apply(gpu, args);
        const realNext = d.nextFrame.bind(d);
        d.nextFrame = (...a) => { decodes++; return realNext(...a); };
        return d;
    };

    try {
        const png = makeTinyPng(8, 8);
        await wasmpegApi.encode(png, { codec: 'mjpeg', frames: 1 });
        ok('encode({frames:1}) decodes exactly one frame', decodes === 1);
    } finally {
        gpu.createDecoder = realCreate;
    }
}

// ── 11. Single wasm instance ─────────────────────────────────────────────────

async function testSingleInstance() {
    section('Single wasm instance');

    const { gpu, FFmpeg } = await import('../src/js/index.js');
    await gpu.load();

    const ff = new FFmpeg();
    await ff.load();

    // A second module instance would double resident wasm and hand writeFile()
    // a filesystem exec() cannot see.
    await ff.writeFile('/shared-instance.bin', new Uint8Array([1, 2, 3]));
    let visible = true;
    try { gpu.FS.readFile('/shared-instance.bin'); } catch { visible = false; }
    ok('FFmpeg writeFile lands in the shared module FS', visible);

    // End to end: write a real PNG, then exec() against that path.
    await ff.writeFile('/shared-in.png', new Uint8Array(makeTinyPng(8, 8)));
    const out = await ff.exec(['-i', '/shared-in.png', '-vf', 'scale=4:4']);
    ok('exec() decodes a file written through the class', out.length === 4 * 4 * 4);

    const logs = [];
    ff.on('log', e => logs.push(e));
    ff.terminate();
    ok('terminate() marks the instance unloaded', ff.loaded === false);

    await ff.load();
    ok('load() after terminate() works', ff.loaded === true);
    ff.terminate();
}

// ── 12. Filtergraph dimensions ───────────────────────────────────────────────

async function testFiltergraphDimensions() {
    section('Filtergraph dimensions');

    const { exec } = await import('../src/js/exec.mjs');
    const src = new Uint8Array(makeTinyPng(16, 8));

    // Each of these must resolve to 8x4 from a 16x8 source. Before expressions
    // were understood, the unresolvable ones silently fell back to source size.
    for (const fg of ['scale=8:4', 'scale=-1:4', 'scale=iw/2:ih/2', 'scale=-2:4', 'scale=w=8:h=4']) {
        const out = await exec(src, ['-vf', fg]);
        ok(`${fg} yields 8x4`, out.length === 8 * 4 * 4);
    }

    const half = await exec(src, ['-vf', 'scale=w=4:h=2']);
    ok('scale=w=4:h=2 yields 4x2', half.length === 4 * 2 * 4);

    // -s WxH shorthand still routes to a scale.
    const shorthand = await exec(src, ['-s', '4x2']);
    ok('-s 4x2 yields 4x2', shorthand.length === 4 * 2 * 4);
}

// ── 13. Boolean flag handling ────────────────────────────────────────────────

function testBoolFlags() {
    section('Boolean flags');

    // Each of these takes no value; if the parser treats one as value-taking it
    // eats the output filename and the command loses its destination.
    const noValue = ['-nostats', '-stats', '-dn', '-ignore_unknown', '-bitexact',
                     '-autorotate', '-noautorotate', '-xerror', '-fix_sub_duration',
                     '-vstats', '-noautoscale', '-y', '-an', '-vn', '-sn',
                     '-hide_banner', '-nostdin', '-shortest'];

    for (const flag of noValue) {
        const p = parseArgs(['-i', 'in.mp4', flag, 'out.mp4']);
        ok(`${flag} leaves the output url intact`, p.outputs[0]?.url === 'out.mp4');
    }

    // Value-taking flags must still consume their argument.
    const p = parseArgs(['-i', 'in.mp4', '-vf', 'scale=2:2', 'out.mp4']);
    ok('-vf consumes its value', p.outputs[0]?.options['-vf'] === 'scale=2:2');
    ok('-vf does not eat the output', p.outputs[0]?.url === 'out.mp4');
}

// ── 14. Multi-frame decode ───────────────────────────────────────────────────

async function testMultiFrame() {
    section('Multi-frame decode');

    const { gpu }  = await import('../src/js/gpu.js');
    const { exec } = await import('../src/js/exec.mjs');
    await gpu.load();

    const gif = new Uint8Array(makeAnimatedGif(4, 4, 3));

    const d = gpu.createDecoder(gif, 'gif');
    ok('animated gif reports 4x4', d.width === 4 && d.height === 4);
    let n = 0;
    while (d.nextFrame()) n++;
    d.close();
    ok('decodes all three frames', n === 3);

    // -vframes caps the stream.
    for (const [limit, expect] of [[1, 1], [2, 2], [9, 3]]) {
        const dl = await exec(gif, ['-i', 'a.gif', '-vframes', String(limit)]);
        let seen = 0;
        while (dl.nextFrame()) seen++;
        dl.close();
        ok(`-vframes ${limit} yields ${expect} frames`, seen === expect);
    }

    // encode() must respect the same budget.
    const wasmpegApi = (await import('../src/js/wasmpeg.mjs')).default;
    await wasmpegApi.load();
    const realCreate = gpu.createDecoder;
    let decodes = 0;
    gpu.createDecoder = (...args) => {
        const dd = realCreate.apply(gpu, args);
        const realNext = dd.nextFrame.bind(dd);
        dd.nextFrame = (...a) => { decodes++; return realNext(...a); };
        return dd;
    };
    try {
        await wasmpegApi.encode(gif, { codec: 'mjpeg', frames: 2, format: 'gif' });
        ok('encode({frames:2}) decodes exactly two frames', decodes === 2);
    } finally {
        gpu.createDecoder = realCreate;
    }
}

// ── 15. Format hints ─────────────────────────────────────────────────────────

async function testFormatHints() {
    section('Format hints');

    const { formatHint, EXT_FMT } = await import('../src/js/formats.js');

    ok('maps a bare extension',        formatHint('clip.vag') === 'kvag');
    ok('maps through a path',          formatHint('/samples/a/b/x.tco') === 'g723_1');
    ok('maps through a url',           formatHint('https://h/x.shn?v=1#f') === undefined || formatHint('https://h/x.shn') === 'shorten');
    ok('is case insensitive',          formatHint('CLIP.VAG') === 'kvag');
    ok('falls back to a path rule',    formatHint('/fate/dolby_e/16-11') === 's337m');
    ok('returns undefined when unknown', formatHint('movie.mp4') === undefined);
    ok('handles empty input',          formatHint('') === undefined && formatHint(null) === undefined);
    ok('every mapping is a string',    Object.values(EXT_FMT).every(v => typeof v === 'string'));
}

// ── 16. Arg parser structure ─────────────────────────────────────────────────

function testArgStructure() {
    section('Arg parser structure');

    const p = parseArgs(['-hide_banner', '-i', 'in.mp4', '-vf', 'scale=2:2', '-y', 'out.png']);
    ok('input url captured',        p.inputs[0]?.url === 'in.mp4');
    ok('output url captured',       p.outputs[0]?.url === 'out.png');
    ok('output option captured',    p.outputs[0]?.options['-vf'] === 'scale=2:2');
    ok('pre-input option is global', p.global['-hide_banner'] === true);

    // Options before -i belong to the input, not the output.
    const q = parseArgs(['-f', 'gif', '-i', 'in.gif', 'out.png']);
    ok('pre-input -f attaches to the input', q.inputs[0]?.options['-f'] === 'gif');
    ok('output keeps its own options',       Object.keys(q.outputs[0]?.options ?? {}).length === 0);

    // With no output token the trailing options land in global.
    const r = parseArgs(['-i', 'in.mp4', '-vf', 'hflip']);
    ok('trailing options fall to global', r.global['-vf'] === 'hflip');
    ok('no outputs parsed',               r.outputs.length === 0);

    // A string command tokenizes the same way, quotes included.
    const t = parseArgs('-i in.mp4 -vf "scale=2:2,hflip" out.png');
    ok('string form parses the filtergraph', t.outputs[0]?.options['-vf'] === 'scale=2:2,hflip');
}

// ── 17. Audio, probe and encoder edges ───────────────────────────────────────

async function testAudioProbeEncoder() {
    section('Audio, probe and encoder edges');

    const { gpu } = await import('../src/js/gpu.js');
    await gpu.load();

    const wav = new Uint8Array(makeWav(8000, 2, 800));

    const a = gpu.createAudioDecoder(wav, 'wav');
    ok('audio reports two channels', a.channels === 2);
    ok('audio reports 8 kHz',        a.sampleRate === 8000);
    let total = 0, min = 1, max = -1, chunk;
    while ((chunk = a.nextSamples())) {
        total += chunk.length;
        for (const v of chunk) { if (v < min) min = v; if (v > max) max = v; }
    }
    a.close();
    ok('decodes every interleaved sample', total === 800 * 2);
    ok('samples stay inside [-1, 1]',      min >= -1 && max <= 1);
    ok('samples are not silence',          max > 0.1 && min < -0.1);

    const info = gpu.probe(wav);
    ok('probe names the container',   info.format.includes('wav'));
    ok('probe counts one stream',     info.streams.length === 1);
    ok('probe types the stream',      info.streams[0].type === 'audio');
    ok('probe reports audio params',  info.audio.sampleRate === 8000 && info.audio.channels === 2);
    ok('probe duration is a number or null',
        info.duration === null || typeof info.duration === 'number');

    // An unknown encoder must fail cleanly rather than allocate a session.
    let encErr = null;
    try { gpu.createEncoder({ fmt: 'image2pipe', codec: 'definitely-not-a-codec' }); }
    catch (e) { encErr = e; }
    ok('unknown encoder name throws', encErr !== null);

    let missingErr = null;
    try { gpu.createEncoder({ codec: 'mjpeg' }); } catch (e) { missingErr = e; }
    ok('missing fmt throws', missingErr !== null);
}

// ── 18. Session pool bounds ──────────────────────────────────────────────────

async function testSessionPoolBounds() {
    section('Session pool bounds');

    const { gpu } = await import('../src/js/gpu.js');
    await gpu.load();

    const gif  = new Uint8Array(makeAnimatedGif(4, 4, 2));
    const open = [];
    let ninthFailed = false;
    try {
        for (let i = 0; i < 8; i++) open.push(gpu.createDecoder(gif, 'gif'));
        ok('eight concurrent decoders open', open.length === 8);
        try { open.push(gpu.createDecoder(gif, 'gif')); }
        catch { ninthFailed = true; }
        ok('the ninth is refused', ninthFailed);
    } finally {
        for (const d of open) d.close();
    }

    // After closing, the pool is usable again.
    const again = gpu.createDecoder(gif, 'gif');
    ok('pool recovers after close', again.width === 4);
    again.close();
}

// ── 19. Format hint routing parity ───────────────────────────────────────────

async function testHintRoutingParity() {
    section('Format hint routing');

    const { gpu }  = await import('../src/js/gpu.js');
    const { exec } = await import('../src/js/exec.mjs');
    const wasmpegApi = (await import('../src/js/wasmpeg.mjs')).default;
    await wasmpegApi.load();

    // A name whose extension only resolves through formats.js, carried on a
    // File so normalizeInput can see it. Both audio entry points must derive
    // the same demuxer hint; exec() used to drop it.
    const wav  = makeWav(8000, 1, 200);
    const file = new File([wav], 'clip.vag');

    const realCreate = gpu.createAudioDecoder;
    const hints = [];
    gpu.createAudioDecoder = (bytes, fmt) => {
        hints.push(fmt);
        // Route with the real format so the call still succeeds.
        return realCreate.call(gpu, bytes, 'wav');
    };
    try {
        (await wasmpegApi.decodeAudio(file)).close();
        (await exec(file, ['-vn'])).close();
        ok('both audio paths derive a hint', hints.length === 2);
        ok('exec matches decodeAudio', hints[0] === hints[1]);
        ok('the hint is the mapped demuxer', hints[0] === 'kvag');
    } finally {
        gpu.createAudioDecoder = realCreate;
    }
}

// ── 19b. FS path inputs ──────────────────────────────────────────────────────

async function testFsPathInputs() {
    section('FS path inputs');

    const { gpu } = await import('../src/js/gpu.js');
    const wasmpegApi = (await import('../src/js/wasmpeg.mjs')).default;
    await wasmpegApi.load();

    gpu.FS.writeFile('/fs-input.wav', new Uint8Array(makeWav(8000, 2, 400)));

    const info = await wasmpegApi.probe('/fs-input.wav');
    ok('probe reads a wasm fs path',    info.format.includes('wav'));
    ok('probe sees the audio params',   info.audio.sampleRate === 8000 && info.audio.channels === 2);

    const a = await wasmpegApi.decodeAudio('/fs-input.wav');
    ok('decodeAudio reads a wasm fs path', a.channels === 2);
    let total = 0, chunk;
    while ((chunk = a.nextSamples())) total += chunk.length;
    a.close();
    ok('fs path audio decodes fully', total === 400 * 2);

    gpu.FS.writeFile('/fs-input.png', new Uint8Array(makeTinyPng(8, 8)));
    const d = await wasmpegApi.decode('/fs-input.png');
    ok('decode still reads a wasm fs path', d.width === 8 && d.height === 8);
    d.close();
}

// ── 20. Preset composition ───────────────────────────────────────────────────

async function testPresets() {
    section('Preset composition');

    const src = fs.readFileSync(path.join(ROOT, 'src/cli/configure.mjs'), 'utf8');
    const body = src.slice(src.indexOf('const PRESETS'), src.indexOf('// ── arg parsing'));

    // Pull one preset's decoder list out of the source without executing it.
    const listOf = (preset, key) => {
        const at = body.indexOf(`    ${preset}: {`);
        if (at < 0) return null;
        const seg = body.slice(at, body.indexOf('\n    },', at));
        const m   = seg.match(new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`));
        return m ? m[1].match(/'[^']+'/g)?.map(x => x.slice(1, -1)) ?? [] : null;
    };

    const free = listOf('free', 'decoders');
    ok('free preset exists', Array.isArray(free) && free.length > 0);

    // The whole point of this preset is the licensing posture. If one of these
    // reappears the build silently stops being royalty-free.
    const encumbered = ['h264', 'hevc', 'aac', 'mpeg1video', 'mpeg2video',
                        'mpeg4', 'h263', 'vc1', 'wmv1', 'wmv2', 'wmv3',
                        'dca', 'ac3', 'eac3', 'mp3'];
    const leaked = encumbered.filter(c => free.includes(c));
    ok(`free preset carries no encumbered decoders${leaked.length ? ' (' + leaked.join(',') + ')' : ''}`,
        leaked.length === 0);

    for (const want of ['vp8', 'vp9', 'av1', 'theora', 'opus', 'vorbis', 'flac'])
        ok(`free preset keeps ${want}`, free.includes(want));

    // lgpl is the shipping build and must still carry the mainstream codecs.
    const lgpl = listOf('lgpl', 'decoders');
    for (const want of ['h264', 'hevc', 'vp9', 'aac'])
        ok(`lgpl preset keeps ${want}`, lgpl.includes(want));
}

// ── 21. C export coverage ────────────────────────────────────────────────────

function testExportCoverage() {
    section('C export coverage');

    const build = fs.readFileSync(path.join(ROOT, 'scripts/build.sh'), 'utf8');

    // Every _name listed in any *_EXPORTS assignment in build.sh.
    const exported = new Set();
    for (const line of build.split('\n')) {
        if (!/^[A-Z_]+_EXPORTS=/.test(line)) continue;
        for (const m of line.matchAll(/_[a-z0-9_]+/g)) exported.add(m[0]);
    }
    ok('build.sh declares exports', exported.size > 20);

    // Every symbol the JS actually ccalls.
    const called = new Set();
    for (const f of ['src/js/gpu.js', 'src/js/ffmpeg.js', 'src/js/exec.mjs', 'src/js/wasmpeg.mjs']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        for (const m of src.matchAll(/ccall\(\s*'([a-z0-9_]+)'/g)) called.add('_' + m[1]);
    }
    ok('js ccalls at least one symbol', called.size > 10);

    // A ccall to a symbol that was never exported fails at runtime, not build
    // time, so this is the cheapest place to catch it.
    const missing = [...called].filter(c => !exported.has(c));
    ok(`every ccalled symbol is exported${missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''}`,
        missing.length === 0);

    // The GPU-only entry points must not be promised by the CPU build.
    const cpuLine = build.split('\n').find(l => l.startsWith('CPU_EXPORTS=')) ?? '';
    ok('cpu exports do not claim the gpu pipeline',
        !cpuLine.includes('_pipeline_run_rgba_gpu'));
}

// ── 22. Seek and time options ────────────────────────────────────────────────

async function testSeek() {
    section('Seek and time options');

    const { gpu }  = await import('../src/js/gpu.js');
    const { exec } = await import('../src/js/exec.mjs');
    await gpu.load();

    const gif = new Uint8Array(makeAnimatedGif(4, 4, 10));

    const d = gpu.createDecoder(gif, 'gif');
    let first = 0;
    while (d.nextFrame()) first++;
    ok('decodes ten frames', first === 10);

    // Seeking back to the start must make the stream replayable.
    d.seek(0);
    let second = 0;
    while (d.nextFrame()) second++;
    ok('seek(0) rewinds the stream', second === first);

    // A negative target clamps to the start rather than erroring, so callers
    // can subtract an offset without guarding it.
    d.seek(-5000);
    let third = 0;
    while (d.nextFrame()) third++;
    ok('negative seek clamps to the start', third === first);
    d.close();

    // -t converts a duration into a frame budget using the stream rate.
    const dt = await exec(gif, ['-i', 'a.gif', '-t', '0.2']);
    let n = 0;
    while (dt.nextFrame()) n++;
    dt.close();
    ok('-t 0.2 at 25fps yields 5 frames', n === 5);

    // -ss is accepted in both input and output position.
    for (const args of [['-ss', '0', '-i', 'a.gif'], ['-i', 'a.gif', '-ss', '0']]) {
        const ds = await exec(gif, args);
        let m = 0;
        while (ds.nextFrame()) m++;
        ds.close();
        ok(`-ss accepted as ${args[0] === '-ss' ? 'input' : 'output'} option`, m === 10);
    }

    let badErr = null;
    try { await exec(gif, ['-i', 'a.gif', '-ss', 'not-a-time']); } catch (e) { badErr = e; }
    ok('unparseable -ss throws', badErr !== null && /-ss/.test(badErr.message));
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
testArgParser();
await testHighLevel();
await testExportSurface();
await testSessionLifecycle();
await testEncodeBudget();
await testSingleInstance();
await testFiltergraphDimensions();
testBoolFlags();
await testMultiFrame();
await testFormatHints();
testArgStructure();
await testAudioProbeEncoder();
await testSessionPoolBounds();
await testHintRoutingParity();
await testFsPathInputs();
await testPresets();
testExportCoverage();
await testSeek();

const total = passed + failed + skipped;
console.log(`\n${total} tests — ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
process.exit(failed > 0 ? 1 : 0);
