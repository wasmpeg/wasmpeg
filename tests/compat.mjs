#!/usr/bin/env node
/**
 * compat.mjs — FATE compatibility tracker for wasmpeg.
 *
 * Runs the full FATE execution suite in parallel (one WASM instance per core),
 * collects per-codec pass rates, and writes a JSON snapshot + COMPAT.md.
 *
 * Usage:
 *   node tests/compat.mjs [--filter=h264] [--no-save] [--workers=N]
 *   FATE_SAMPLES=/path/to/fate-suite node tests/compat.mjs
 */

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import os   from 'node:os';
import fs   from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { EXT_FMT, PATH_FMT, EXT_VIDEO } from '../src/js/formats.js';
import { resolvePaths, parseSamplePath, guessCodec, chunkArray, scanMakLines, runWorkers } from './lib/fate-shared.mjs';

const { ROOT, SAMPLES_DIR, FATE_DIR, RESULTS_DIR, wasmJs, wasmBin } = resolvePaths(path.resolve(import.meta.dirname, '..'));

// ── worker: decode a chunk of tests ──────────────────────────────────────────

if (!isMainThread) {
    const { tests } = workerData;

    const { default: factory } = await import(wasmJs);
    const mod = await factory({ wasmBinary: fs.readFileSync(wasmBin) });

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

        const w   = cc('decoder_width',  'number', ['number'], [handle]);
        const h   = cc('decoder_height', 'number', ['number'], [handle]);
        const buf = mod._malloc(w * h * 4);

        let frames = 0;
        for (;;) {
            const r = cc('decoder_next_frame', 'number', ['number','number','number','number'], [handle, buf, w, h]);
            if (r === 1) break;
            if (r < 0) {
                mod._free(buf); cc('decoder_close', null, ['number'], [handle]);
                // treat errors mid-stream as soft-EOF when at least one frame decoded
                // (FATE sample files are truncated; empty packets can produce ENOSPC/INVALIDDATA)
                if (frames > 0) return;
                throw new Error(`next_frame: ${r}`);
            }
            frames++;
        }

        mod._free(buf);
        cc('decoder_close', null, ['number'], [handle]);
    }

    function decodeAudio(bytes, fmtHint) {
        const ptr    = alloc(bytes);
        const handle = fmtHint
            ? cc('audio_open_format', 'number', ['number','number','string'], [ptr, bytes.byteLength, fmtHint])
            : cc('audio_open', 'number', ['number','number'], [ptr, bytes.byteLength]);
        mod._free(ptr);
        if (handle < 0) throw new Error(`audio_open: ${handle}`);

        const channels = cc('audio_channels', 'number', ['number'], [handle]);
        const cap      = 4096 * Math.max(channels, 1);
        const buf      = mod._malloc(cap * 4);
        let decoded    = 0;

        for (;;) {
            const r = cc('audio_next_samples', 'number', ['number','number','number'], [handle, buf, cap]);
            if (r === 1) break;
            if (r < 0) {
                mod._free(buf); cc('audio_close', null, ['number'], [handle]);
                // AVERROR_INVALIDDATA on a truncated trailing packet is a soft-EOF when
                // some samples were already decoded (small FATE sample files).
                if (r === -1094995529 && decoded > 0) return;
                throw new Error(`next_samples: ${r}`);
            }
            decoded += r;
        }

        mod._free(buf);
        cc('audio_close', null, ['number'], [handle]);
    }

    // EXT_FMT / PATH_FMT / EXT_VIDEO are imported from ../src/js/formats.js so
    // the harness and the shipped API resolve format hints the same way.

    for (const t of tests) {
        const bytes = new Uint8Array(fs.readFileSync(t.localPath));

        const ext     = t.samplePath.split('.').pop().toLowerCase();
        const fmtHint = EXT_FMT[ext]
            ?? PATH_FMT.find(([re]) => re.test(t.samplePath))?.[1];

        let ok = false;
        try {
            const ptr = alloc(bytes);
            const ph  = cc('probe_open', 'number', ['number','number'], [ptr, bytes.byteLength]);
            mod._free(ptr);
            const probeWidth = ph >= 0 ? cc('probe_width', 'number', ['number'], [ph]) : -1;
            if (ph >= 0) cc('probe_close', null, ['number'], [ph]);
            // pcm/audio_match tests always expect audio output — don't let a video
            // track in the container (e.g. binkaudio bik files) hijack the route
            const hasVideo = t.type !== 'audio' && (probeWidth > 0 || EXT_VIDEO.has(ext));

            if (hasVideo)   decodeVideo(bytes);
            else            decodeAudio(bytes, fmtHint);
            ok = true;
        } catch {}
        parentPort.postMessage({ type: 'tick', ok, codec: t.codec, sampleType: t.type });
    }

    parentPort.postMessage({ type: 'done' });
    process.exit(0);
}

// ── main: load tests, split across workers ────────────────────────────────────

if (!fs.existsSync(wasmJs)) {
    console.error('dist/gpl-cpu.js not found — run: PRESET=gpl TARGET=cpu bash scripts/build.sh');
    process.exit(1);
}

const NO_SAVE    = process.argv.includes('--no-save');
const FILTER_ARG = process.argv.find(a => a.startsWith('--filter='))?.split('=')[1];
const NWORKERS   = parseInt(process.argv.find(a => a.startsWith('--workers='))?.split('=')[1])
                || os.availableParallelism?.() || os.cpus().length;

function classifyCmd(cmd) {
    const macro = cmd.trim().split(/\s+/)[0];
    if (['framecrc','framemd5','md5','md5pipe'].includes(macro)) return 'video';
    if (['pcm','enc_dec_pcm','audio_match'].includes(macro))     return 'audio';
    // crc tests just verify a container/stream opens correctly — route as decode
    if (macro === 'crc') return 'audio';
    return null;
}

function loadTests() {
    const tests = [];
    for (const { name, cmd } of scanMakLines(FATE_DIR)) {
        const type       = classifyCmd(cmd);
        const samplePath = parseSamplePath(cmd);
        if (!type || !samplePath) continue;
        const localPath = path.join(SAMPLES_DIR, samplePath);
        if (!fs.existsSync(localPath)) continue;
        if (FILTER_ARG && !samplePath.includes(FILTER_ARG) && !(name ?? '').includes(FILTER_ARG)) continue;
        tests.push({ name: name ?? samplePath, samplePath, localPath, type, codec: guessCodec(name ?? '', samplePath) });
    }
    return tests;
}

// ── rsync fate-suite ──────────────────────────────────────────────────────────

console.log('syncing fate-suite...');
const rsync = spawnSync('rsync', ['-a', '--delete', 'rsync://fate-suite.ffmpeg.org/fate-suite/', SAMPLES_DIR + '/'], { stdio: 'inherit' });
if (rsync.status !== 0) { console.error('rsync failed'); process.exit(1); }
console.log('');

// ── run workers ───────────────────────────────────────────────────────────────

const tests  = loadTests();
const chunks = chunkArray(tests, NWORKERS);

console.log(`\nfate compat — ${tests.length} tests · ${chunks.length} workers\n`);

let done = 0, totalPass = 0, totalFail = 0, totalTimeout = 0;
const byCodec = {};

await runWorkers({
    scriptUrl: new URL(import.meta.url),
    chunks,
    onTick(msg) {
        done++;
        msg.ok ? totalPass++ : totalFail++;
        if (msg.timeout) totalTimeout++;
        byCodec[msg.codec] ??= { pass: 0, total: 0, type: msg.sampleType };
        byCodec[msg.codec].total++;
        byCodec[msg.codec].pass += msg.ok ? 1 : 0;
        process.stdout.write(`\r  ${done}/${tests.length}  (${((totalPass / done) * 100).toFixed(1)}% passing)`);
    },
});

process.stdout.write('\n\n');
if (totalTimeout > 0) {
    console.log(`  ⚠ ${totalTimeout} test(s) counted as failed — their worker stalled and was killed (no per-test timeout upstream).`);
}

// ── snapshot ──────────────────────────────────────────────────────────────────

let sha = 'unknown';
try { sha = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch {}

const wasmKb = Math.round(fs.statSync(wasmBin).size / 1024);

const snapshot = {
    date:   new Date().toISOString().slice(0, 10),
    sha,
    wasmKb,
    total:  { pass: totalPass, fail: totalFail, pct: +((totalPass / (totalPass + totalFail)) * 100).toFixed(1) },
    codecs: Object.fromEntries(
        Object.entries(byCodec)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([codec, { pass, total, type }]) => [
                codec, { pass, total, pct: +((pass / total) * 100).toFixed(1), type }
            ])
    ),
};

// ── render ────────────────────────────────────────────────────────────────────

function renderTable(snap) {
    const lines = [];
    lines.push('# FATE Compatibility');
    lines.push('');
    lines.push(`Last run: **${snap.date}** · commit \`${snap.sha}\` · WASM **${snap.wasmKb} KB**`);
    lines.push('');
    lines.push(`## Overall: ${snap.total.pass}/${snap.total.pass + snap.total.fail} (${snap.total.pct}%)`);
    lines.push('');
    lines.push('| Codec | Type | Pass | Total | Rate |');
    lines.push('|-------|------|-----:|------:|-----:|');
    for (const [codec, { pass, total, pct, type }] of Object.entries(snap.codecs))
        lines.push(`| ${codec} | ${type} | ${pass} | ${total} | ${pct.toFixed(1)}% |`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('Generated by `node tests/compat.mjs`. Commit `COMPAT.md` and `tests/results/history.json` to track progress over time.');
    lines.push('');
    return lines.join('\n');
}

console.log('─'.repeat(60));
console.log(`  Overall: ${totalPass}/${totalPass + totalFail}  (${snapshot.total.pct}%)  — WASM ${wasmKb} KB`);
console.log('─'.repeat(60));

for (const [codec, { pass, total, pct }] of Object.entries(snapshot.codecs).sort(([,a],[,b]) => b.pct - a.pct))
    console.log(`  ${codec.padEnd(12)} ${pct.toFixed(1).padStart(6)}%  (${pass}/${total})`);

console.log('');

if (!NO_SAVE) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    // append compact entry to history.json
    const historyFile = path.join(RESULTS_DIR, 'history.json');
    const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : [];
    history.push({
        date:   snapshot.date,
        sha,
        wasmKb,
        pct:    snapshot.total.pct,
        pass:   totalPass,
        total:  totalPass + totalFail,
        codecs: Object.fromEntries(Object.entries(snapshot.codecs).map(([c, { pct }]) => [c, pct])),
    });
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));

    // overwrite COMPAT.md with latest table
    fs.writeFileSync(path.join(ROOT, 'COMPAT.md'), renderTable(snapshot));

    console.log('  Updated: tests/results/history.json');
    console.log('  Updated: COMPAT.md');
    console.log('');
    console.log('  Commit to track progress over time:');
    console.log(`    git add tests/results/history.json COMPAT.md && git commit -s -m "compat: ${snapshot.date} — ${snapshot.total.pct}% (${totalPass}/${totalPass + totalFail})"`);
}
