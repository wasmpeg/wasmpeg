/**
 * fate-exec.mjs — execute FATE decode tests against our WASM pipeline.
 *
 * Parses all FATE .mak files, finds framecrc/pcm tests where the sample
 * file exists locally, then runs our video or audio decoder on each.
 * Reports pass/fail + timing for benchmarking.
 *
 * Usage:
 *   node tests/fate-exec.mjs [--verbose] [--filter=h264] [--limit=N]
 *   FATE_SAMPLES=/path/to/fate-suite node tests/fate-exec.mjs
 */

import fs   from 'node:fs';
import path from 'node:path';

const ROOT        = path.resolve(import.meta.dirname, '..');
const SAMPLES_DIR = process.env.FATE_SAMPLES ?? path.join(ROOT, 'fate-suite');
const FATE_DIR    = path.join(ROOT, 'vendor/ffmpeg/tests/fate');
const VERBOSE     = process.argv.includes('--verbose');
const FILTER_ARG  = process.argv.find(a => a.startsWith('--filter='))?.split('=')[1];
const LIMIT       = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '0');

// ── load WASM ─────────────────────────────────────────────────────────────────

const wasmJs  = path.join(ROOT, 'dist/cpu.js');
const wasmBin = path.join(ROOT, 'dist/cpu.wasm');

if (!fs.existsSync(wasmJs)) {
    console.error('dist/cpu.js not found — run: TARGET=cpu bash scripts/build.sh');
    process.exit(1);
}

const { default: factory } = await import(wasmJs);
const mod = await factory({ wasmBinary: fs.readFileSync(wasmBin) });

// ── pipeline helpers ──────────────────────────────────────────────────────────

function cc(fn, ret, types, args) { return mod.ccall(fn, ret, types, args); }

function alloc(bytes) {
    const ptr = mod._malloc(bytes.byteLength);
    mod.HEAPU8.set(bytes, ptr);
    return ptr;
}

function decodeVideo(bytes) {
    const ptr    = alloc(bytes);
    const handle = cc('decoder_open', 'number', ['number','number'], [ptr, bytes.byteLength]);
    mod._free(ptr);
    if (handle < 0) throw new Error(`decoder_open: ${handle}`);

    const w = cc('decoder_width',  'number', ['number'], [handle]);
    const h = cc('decoder_height', 'number', ['number'], [handle]);
    const buf = mod._malloc(w * h * 4);

    let frames = 0;
    const t0 = Date.now();
    for (;;) {
        const r = cc('decoder_next_frame', 'number', ['number','number','number','number'], [handle, buf, w, h]);
        if (r === 1) break;
        if (r < 0) { mod._free(buf); cc('decoder_close', null, ['number'], [handle]); throw new Error(`next_frame: ${r}`); }
        frames++;
    }
    const ms = Date.now() - t0;

    mod._free(buf);
    cc('decoder_close', null, ['number'], [handle]);
    return { frames, ms, w, h };
}

function decodeAudio(bytes) {
    const ptr    = alloc(bytes);
    const handle = cc('audio_open', 'number', ['number','number'], [ptr, bytes.byteLength]);
    mod._free(ptr);
    if (handle < 0) throw new Error(`audio_open: ${handle}`);

    const channels   = cc('audio_channels',    'number', ['number'], [handle]);
    const sampleRate = cc('audio_sample_rate', 'number', ['number'], [handle]);
    const cap        = 4096 * channels;
    const buf        = mod._malloc(cap * 4);

    let chunks = 0, totalSamples = 0;
    const t0 = Date.now();
    for (;;) {
        const r = cc('audio_next_samples', 'number', ['number','number','number'], [handle, buf, cap]);
        if (r === 1) break;
        if (r < 0) { mod._free(buf); cc('audio_close', null, ['number'], [handle]); throw new Error(`next_samples: ${r}`); }
        chunks++;
        totalSamples += r;
    }
    const ms = Date.now() - t0;

    mod._free(buf);
    cc('audio_close', null, ['number'], [handle]);
    return { chunks, totalSamples, sampleRate, channels, ms };
}

// ── FATE .mak parser ──────────────────────────────────────────────────────────

// Determine whether a CMD is a video decode, audio decode, or skip.
function classifyCmd(cmd) {
    const macro = cmd.trim().split(/\s+/)[0];
    if (['framecrc','framemd5','md5','md5pipe'].includes(macro)) return 'video';
    if (['pcm','enc_dec_pcm','audio_match'].includes(macro))     return 'audio';
    return null;
}

function parseSamplePath(cmd) {
    const m = cmd.match(/\$\(TARGET_SAMPLES\)\/([^\s)]+)/);
    return m ? m[1] : null;
}

function loadTests() {
    const tests = [];
    for (const mak of fs.readdirSync(FATE_DIR).filter(f => f.endsWith('.mak'))) {
        const text  = fs.readFileSync(path.join(FATE_DIR, mak), 'utf8');
        const lines = text.replace(/\\\n/g, ' ').split('\n');
        let lastName = null;
        for (const line of lines) {
            const nm = line.match(/^(fate-[\w-]+)\s*:/);
            if (nm) lastName = nm[1];
            const cm = line.match(/CMD\s*=\s*(.+)/);
            if (!cm) continue;
            const cmd        = cm[1].trim();
            const type       = classifyCmd(cmd);
            const samplePath = parseSamplePath(cmd);
            if (!type || !samplePath) continue;
            const localPath = path.join(SAMPLES_DIR, samplePath);
            if (!fs.existsSync(localPath)) continue;
            if (FILTER_ARG && !samplePath.includes(FILTER_ARG) && !(lastName ?? '').includes(FILTER_ARG)) continue;
            tests.push({ name: lastName ?? samplePath, samplePath, localPath, type });
        }
    }
    return tests;
}

// ── run ───────────────────────────────────────────────────────────────────────

const allTests = loadTests();
const tests    = LIMIT > 0 ? allTests.slice(0, LIMIT) : allTests;

console.log(`\nfate execution tests — ${tests.length} runnable (${allTests.length} total with samples)\n`);

const stats    = { pass: 0, fail: 0, video: 0, audio: 0 };
const failures = [];
const timings  = [];

for (const t of tests) {
    const bytes = new Uint8Array(fs.readFileSync(t.localPath));
    let result  = null;
    let error   = null;

    try {
        result = t.type === 'audio' ? decodeAudio(bytes) : decodeVideo(bytes);
        stats.pass++;
        stats[t.type]++;
        timings.push({ ...t, ...result });
        if (VERBOSE) {
            if (t.type === 'video')
                console.log(`  PASS  [${t.type}] ${t.name}  ${result.w}x${result.h} ${result.frames}f  ${result.ms}ms`);
            else
                console.log(`  PASS  [${t.type}] ${t.name}  ${result.channels}ch@${result.sampleRate}Hz  ${result.chunks} chunks  ${result.ms}ms`);
        }
    } catch (e) {
        error = e.message;
        stats.fail++;
        failures.push({ ...t, error });
        if (VERBOSE) console.error(`  FAIL  [${t.type}] ${t.name}  — ${error}`);
    }
}

// ── report ────────────────────────────────────────────────────────────────────

const total = stats.pass + stats.fail;
console.log('fate execution results');
console.log('─'.repeat(55));
console.log(`  Total run:   ${total}`);
console.log(`  Pass:        ${stats.pass}  (video: ${stats.video}, audio: ${stats.audio})`);
console.log(`  Fail:        ${stats.fail}`);
console.log(`  Pass rate:   ${((stats.pass / total) * 100).toFixed(1)}%`);

if (timings.length) {
    // top 5 slowest
    const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 5);
    console.log('\n  Slowest decodes:');
    for (const t of slowest) {
        const desc = t.frames != null
            ? `${t.frames} frames  ${t.ms}ms`
            : `${t.chunks} chunks  ${t.ms}ms`;
        console.log(`    ${t.ms.toString().padStart(5)}ms  ${path.basename(t.samplePath)}  (${desc})`);
    }
}

console.log('');

if (failures.length && !VERBOSE) {
    const shown = failures.slice(0, 20);
    console.log(`Failures (${failures.length} total):`);
    for (const { name, error } of shown)
        console.log(`  ${name}: ${error}`);
    if (failures.length > 20) console.log(`  … and ${failures.length - 20} more`);
}
