/**
 * fate-exec.mjs — execute FATE h264-conformance tests against our WASM decoder.
 *
 * Loads the CPU WASM, opens each sample with gpu.createDecoder(), drains all frames,
 * and reports pass/fail. Does not compare checksums — tests pass if the decoder
 * opens and drains without throwing.
 *
 * Usage:
 *   node tests/fate-exec.mjs [--verbose] [--filter=BA1]
 *   FATE_SAMPLES=/path/to/fate-suite node tests/fate-exec.mjs
 */

import fs   from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT        = path.resolve(import.meta.dirname, '..');
const SAMPLES_DIR = process.env.FATE_SAMPLES
    ?? path.join(ROOT, 'fate-suite/h264-conformance/h264-conformance');
const VERBOSE     = process.argv.includes('--verbose');
const FILTER_ARG  = process.argv.find(a => a.startsWith('--filter='))?.split('=')[1];

// ── load WASM ─────────────────────────────────────────────────────────────────

const wasmJs   = path.join(ROOT, 'dist/cpu.js');
const wasmBin  = path.join(ROOT, 'dist/cpu.wasm');

if (!fs.existsSync(wasmJs)) {
    console.error('dist/cpu.js not found — run: TARGET=cpu bash scripts/build.sh');
    process.exit(1);
}
if (!fs.existsSync(SAMPLES_DIR)) {
    console.error(`samples not found at: ${SAMPLES_DIR}`);
    console.error('run: rsync -av rsync://fate.ffmpeg.org/fate-suite/h264-conformance/ fate-suite/h264-conformance/');
    process.exit(1);
}

const { default: factory } = await import(wasmJs);
const mod = await factory({ wasmBinary: fs.readFileSync(wasmBin) });

// ── helpers ───────────────────────────────────────────────────────────────────

function ccall(fn, ret, argTypes, args) {
    return mod.ccall(fn, ret, argTypes, args);
}

function decodeAll(fileBytes) {
    const srcPtr = mod._malloc(fileBytes.byteLength);
    mod.HEAPU8.set(fileBytes, srcPtr);
    const handle = ccall('decoder_open', 'number', ['number','number'], [srcPtr, fileBytes.byteLength]);
    mod._free(srcPtr);
    if (handle < 0) throw new Error(`decoder_open: ${handle}`);

    const w = ccall('decoder_width',  'number', ['number'], [handle]);
    const h = ccall('decoder_height', 'number', ['number'], [handle]);
    const frameBuf = mod._malloc(w * h * 4);

    let frames = 0;
    for (;;) {
        const ret = ccall('decoder_next_frame', 'number',
            ['number','number','number','number'], [handle, frameBuf, w, h]);
        if (ret === 1) break;   // EOF
        if (ret < 0) { mod._free(frameBuf); ccall('decoder_close', null, ['number'], [handle]); throw new Error(`decoder_next_frame: ${ret}`); }
        frames++;
    }

    mod._free(frameBuf);
    ccall('decoder_close', null, ['number'], [handle]);
    return frames;
}

// ── discover tests ────────────────────────────────────────────────────────────

const files = fs.readdirSync(SAMPLES_DIR)
    .filter(f => /\.(264|jsv|h264|avc)$/i.test(f))
    .filter(f => !FILTER_ARG || f.toLowerCase().includes(FILTER_ARG.toLowerCase()))
    .sort();

// ── run ───────────────────────────────────────────────────────────────────────

const stats = { pass: 0, fail: 0 };
const failures = [];

console.log(`running ${files.length} h264-conformance execution tests...\n`);

for (const file of files) {
    const filePath = path.join(SAMPLES_DIR, file);
    const bytes    = new Uint8Array(fs.readFileSync(filePath));
    let   frames   = 0;
    let   error    = null;

    try {
        frames = decodeAll(bytes);
        stats.pass++;
        if (VERBOSE) console.log(`  PASS  ${file}  (${frames} frames)`);
    } catch (e) {
        error = e.message;
        stats.fail++;
        failures.push({ file, error });
        if (VERBOSE) console.error(`  FAIL  ${file}  — ${error}`);
    }
}

// ── report ────────────────────────────────────────────────────────────────────

console.log('');
console.log('h264-conformance execution results');
console.log('─'.repeat(50));
console.log(`  Files tested:  ${files.length}`);
console.log(`  Pass:          ${stats.pass}`);
console.log(`  Fail:          ${stats.fail}`);
if (files.length > 0)
    console.log(`  Pass rate:     ${((stats.pass / files.length) * 100).toFixed(1)}%`);
console.log('');

if (failures.length && !VERBOSE) {
    console.log('Failures:');
    for (const { file, error } of failures)
        console.log(`  ${file}: ${error}`);
}
