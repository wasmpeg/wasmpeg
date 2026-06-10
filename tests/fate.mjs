#!/usr/bin/env node
/**
 * fate.mjs — FATE correctness tracker for wasmpeg.
 *
 * For every pure-decode video framecrc test in the suite, this decodes each
 * frame in its native pixel format and checks the per-frame Adler-32 against
 * FFmpeg's own reference output in vendor/ffmpeg/tests/ref/fate/. A test passes
 * only when every frame's checksum matches exactly — so this measures whether
 * we decode *correctly*, not just whether decoding runs without erroring (that's
 * what tests/compat.mjs tracks).
 *
 * No native ffmpeg needed: the reference checksums are vendored and match our
 * exact FFmpeg version.
 *
 * Usage:
 *   node tests/fate.mjs [--filter=h264] [--no-save] [--workers=N]
 *   FATE_SAMPLES=/path/to/fate-suite node tests/fate.mjs
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os   from 'node:os';
import fs   from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT        = path.resolve(import.meta.dirname, '..');
const SAMPLES_DIR = process.env.FATE_SAMPLES ?? path.join(ROOT, 'fate-suite');
const FATE_DIR    = path.join(ROOT, 'vendor/ffmpeg/tests/fate');
const REF_DIR     = path.join(ROOT, 'vendor/ffmpeg/tests/ref/fate');
const RESULTS_DIR = path.join(ROOT, 'tests/results');
const wasmJs      = path.join(ROOT, 'dist/gpl-cpu.js');
const wasmBin     = path.join(ROOT, 'dist/gpl-cpu.wasm');

// FFmpeg's framecrc muxer checksums each frame with Adler-32 seeded at 0.
function adler32(buf) {
    let s1 = 0, s2 = 0;
    const BASE = 65521;
    for (let i = 0; i < buf.length; i++) {
        s1 = (s1 + buf[i]) % BASE;
        s2 = (s2 + s1) % BASE;
    }
    return ((s2 << 16) | s1) >>> 0;
}

// ── worker: decode a chunk of tests and check checksums ───────────────────────

if (!isMainThread) {
    const { tests } = workerData;

    const { default: factory } = await import(wasmJs);
    const mod = await factory({ wasmBinary: fs.readFileSync(wasmBin) });
    function cc(fn, ret, types, args) { return mod.ccall(fn, ret, types, args); }

    const byCodec = {};

    for (const t of tests) {
        byCodec[t.codec] ??= { pass: 0, total: 0 };
        byCodec[t.codec].total++;

        let ok = false;
        try {
            const bytes  = new Uint8Array(fs.readFileSync(t.localPath));
            const srcPtr = mod._malloc(bytes.byteLength);
            mod.HEAPU8.set(bytes, srcPtr);
            const handle = cc('decoder_open', 'number', ['number','number'], [srcPtr, bytes.byteLength]);
            mod._free(srcPtr);

            if (handle >= 0) {
                const w   = cc('decoder_width',  'number', ['number'], [handle]);
                const h   = cc('decoder_height', 'number', ['number'], [handle]);
                const cap = Math.max(w * h * 8, 1 << 16);
                const buf = mod._malloc(cap);

                const got = [];
                // Decode one past the reference count so over-production is caught.
                // A negative return is treated the same as EOF: many FATE samples are
                // truncated mid-frame, where native ffmpeg stops cleanly but our decoder
                // reports an error on the partial tail. As long as the frames we did
                // produce match the reference exactly, that's a correct decode.
                for (let i = 0; i < t.crcs.length + 1; i++) {
                    const sz = cc('decoder_next_raw_frame', 'number', ['number','number','number'], [handle, buf, cap]);
                    if (sz <= 0) break;
                    got.push({ size: sz, crc: adler32(new Uint8Array(mod.HEAPU8.buffer, buf, sz)) });
                }
                mod._free(buf);
                cc('decoder_close', null, ['number'], [handle]);

                ok = got.length === t.crcs.length &&
                     got.every((g, i) => g.crc === t.crcs[i].crc && g.size === t.crcs[i].size);
            }
        } catch {}

        byCodec[t.codec].pass += ok ? 1 : 0;
        parentPort.postMessage({ type: 'tick', ok });
    }

    parentPort.postMessage({ type: 'done', byCodec });
    process.exit(0);
}

// ── main: select tests, split across workers ──────────────────────────────────

if (!fs.existsSync(wasmJs)) {
    console.error('dist/gpl-cpu.js not found — run: PRESET=gpl TARGET=cpu bash scripts/build.sh');
    process.exit(1);
}

const NO_SAVE    = process.argv.includes('--no-save');
const FILTER_ARG = process.argv.find(a => a.startsWith('--filter='))?.split('=')[1];
const NWORKERS   = parseInt(process.argv.find(a => a.startsWith('--workers='))?.split('=')[1])
                || os.availableParallelism?.() || os.cpus().length;

// Flags that transform frames or limit output — a test carrying any of these is
// not a pure decode, so its reference won't match raw decoded frames. Skip them.
const TRANSFORM_FLAGS = new Set([
    '-vf', '-af', '-filter_complex', '-lavfi', '-filter:v', '-filter:a',
    '-pix_fmt', '-s', '-map', '-c', '-vcodec', '-acodec', '-r',
    '-vframes', '-frames', '-ss', '-t', '-to',
]);

function parseSamplePath(cmd) {
    const m = cmd.match(/\$\(TARGET_SAMPLES\)\/([^\s)]+)/);
    return m ? m[1] : null;
}

function isPureDecode(cmd) {
    const toks = cmd.trim().split(/\s+/);
    for (const tok of toks) {
        if (!tok.startsWith('-')) continue;
        const base = tok.indexOf(':') > 0 ? tok.slice(0, tok.indexOf(':')) : tok;
        if (TRANSFORM_FLAGS.has(tok) || TRANSFORM_FLAGS.has(base)) return false;
    }
    return true;
}

// Parse a vendored reference file. Returns the per-frame { size, crc } list for
// stream 0, but only for single-stream video references (so our video decoder's
// output lines up with the reference).
function refInfo(refName) {
    const p = path.join(REF_DIR, refName);
    if (!fs.existsSync(p)) return null;
    let mediaVideo = false, nStreams = 0;
    const crcs = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        if (line.startsWith('#media_type')) {
            nStreams++;
            if (line.startsWith('#media_type 0: video')) mediaVideo = true;
        }
        if (line.startsWith('#') || !line.trim()) continue;
        const c = line.split(',').map(x => x.trim());
        if (c[0] !== '0') continue;
        const m = c[c.length - 1].match(/0x([0-9a-fA-F]+)/);
        if (m) crcs.push({ size: +c[4], crc: parseInt(m[1], 16) >>> 0 });
    }
    if (!mediaVideo || nStreams !== 1 || crcs.length === 0) return null;
    return crcs;
}

function guessCodec(name, samplePath) {
    const known = [
        'h264','hevc','vp8','vp9','av1','mpeg1','mpeg2','mpeg4','h263','h261',
        'wmv1','wmv2','wmv3','vc1','mss2','prores','dnxhd','mjpeg','qtrle','svq1','svq3','cfhd',
        'huffyuv','ffv1','magicyuv','lagarith','hap','utvideo','bink','cllc','canopus',
        'theora','vp3','vp6','vp7','cinepak','msvideo1','indeo','loco','msrle','dv',
        'exr','psd','jpeg2000','jpegls','webp','tiff','bmp','gif','png','dpx','tga',
        'fraps','cdxl','flic','zmbv','speedhq','qoi','avif',
    ];
    const hay = (name + ' ' + samplePath).toLowerCase();
    for (const c of known) if (hay.includes(c)) return c;
    return 'other';
}

function loadTests() {
    const tests = [];
    for (const mak of fs.readdirSync(FATE_DIR).filter(f => f.endsWith('.mak'))) {
        const text  = fs.readFileSync(path.join(FATE_DIR, mak), 'utf8').replace(/\\\n/g, ' ');
        let lastName = null;
        for (const line of text.split('\n')) {
            const nm = line.match(/^(fate-[\w-]+)\s*:/);
            if (nm) lastName = nm[1];
            const cm = line.match(/CMD\s*=\s*(.+)/);
            if (!cm || !lastName) continue;
            const cmd = cm[1].trim();
            if (cmd.split(/\s+/)[0] !== 'framecrc') continue;
            if (!isPureDecode(cmd)) continue;

            const samplePath = parseSamplePath(cmd);
            if (!samplePath) continue;
            const localPath = path.join(SAMPLES_DIR, samplePath);
            if (!fs.existsSync(localPath)) continue;

            const crcs = refInfo(lastName.replace(/^fate-/, ''));
            if (!crcs) continue;

            if (FILTER_ARG && !samplePath.includes(FILTER_ARG) && !lastName.includes(FILTER_ARG)) continue;

            tests.push({ name: lastName, localPath, samplePath, crcs, codec: guessCodec(lastName, samplePath) });
        }
    }
    return tests;
}

function chunkArray(arr, n) {
    const chunks = Array.from({ length: n }, () => []);
    arr.forEach((item, i) => chunks[i % n].push(item));
    return chunks.filter(c => c.length > 0);
}

const tests = loadTests();
if (tests.length === 0) {
    console.error('no pure-decode video framecrc tests with local samples found');
    process.exit(1);
}
const chunks = chunkArray(tests, NWORKERS);

console.log(`\nfate correctness — ${tests.length} pure-decode video tests · ${chunks.length} workers\n`);

let done = 0, totalPass = 0, totalFail = 0;
const byCodec = {};

await new Promise((resolve, reject) => {
    let finished = 0;
    for (const chunk of chunks) {
        const w = new Worker(new URL(import.meta.url), { workerData: { tests: chunk } });
        w.on('message', msg => {
            if (msg.type === 'tick') {
                done++;
                msg.ok ? totalPass++ : totalFail++;
                process.stdout.write(`\r  ${done}/${tests.length}  (${((totalPass / done) * 100).toFixed(1)}% correct)`);
            } else if (msg.type === 'done') {
                for (const [codec, { pass, total }] of Object.entries(msg.byCodec)) {
                    byCodec[codec] ??= { pass: 0, total: 0 };
                    byCodec[codec].pass  += pass;
                    byCodec[codec].total += total;
                }
                if (++finished === chunks.length) resolve();
            }
        });
        w.on('error', reject);
    }
});

process.stdout.write('\n\n');

// ── snapshot ──────────────────────────────────────────────────────────────────

let sha = 'unknown';
try { sha = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch {}

const snapshot = {
    date:   new Date().toISOString().slice(0, 10),
    sha,
    total:  { pass: totalPass, fail: totalFail, pct: +((totalPass / (totalPass + totalFail)) * 100).toFixed(1) },
    codecs: Object.fromEntries(
        Object.entries(byCodec)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([codec, { pass, total }]) => [codec, { pass, total, pct: +((pass / total) * 100).toFixed(1) }])
    ),
};

console.log('─'.repeat(60));
console.log(`  Correct: ${totalPass}/${totalPass + totalFail}  (${snapshot.total.pct}%)  — exact-match vs FATE refs`);
console.log('─'.repeat(60));
for (const [codec, { pass, total, pct }] of Object.entries(snapshot.codecs).sort(([,a],[,b]) => b.pct - a.pct))
    console.log(`  ${codec.padEnd(12)} ${pct.toFixed(1).padStart(6)}%  (${pass}/${total})`);
console.log('');

// ── render + save ─────────────────────────────────────────────────────────────

function renderTable(snap) {
    const lines = [];
    lines.push('# FATE Decode Correctness');
    lines.push('');
    lines.push(`Last run: **${snap.date}** · commit \`${snap.sha}\``);
    lines.push('');
    lines.push('Exact per-frame Adler-32 match against FFmpeg\'s vendored FATE reference output,');
    lines.push('over pure-decode video `framecrc` tests. A test passes only when every frame is');
    lines.push('byte-identical to the reference. This is stricter than [COMPAT.md](COMPAT.md),');
    lines.push('which only checks that decoding runs without erroring.');
    lines.push('');
    lines.push(`## Overall: ${snap.total.pass}/${snap.total.pass + snap.total.fail} (${snap.total.pct}%)`);
    lines.push('');
    lines.push('| Codec | Correct | Total | Rate |');
    lines.push('|-------|--------:|------:|-----:|');
    for (const [codec, { pass, total, pct }] of Object.entries(snap.codecs))
        lines.push(`| ${codec} | ${pass} | ${total} | ${pct.toFixed(1)}% |`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('Generated by `node tests/fate.mjs`.');
    lines.push('');
    return lines.join('\n');
}

if (!NO_SAVE) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const historyFile = path.join(RESULTS_DIR, 'correctness-history.json');
    const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : [];
    history.push({
        date:   snapshot.date,
        sha,
        pct:    snapshot.total.pct,
        pass:   totalPass,
        total:  totalPass + totalFail,
        codecs: Object.fromEntries(Object.entries(snapshot.codecs).map(([c, { pct }]) => [c, pct])),
    });
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
    fs.writeFileSync(path.join(ROOT, 'CORRECTNESS.md'), renderTable(snapshot));
    console.log('  Updated: CORRECTNESS.md, tests/results/correctness-history.json\n');
}
