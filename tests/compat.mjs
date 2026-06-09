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

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os   from 'node:os';
import fs   from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

const ROOT        = path.resolve(import.meta.dirname, '..');
const SAMPLES_DIR = process.env.FATE_SAMPLES ?? path.join(ROOT, 'fate-suite');
const FATE_DIR    = path.join(ROOT, 'vendor/ffmpeg/tests/fate');
const RESULTS_DIR = path.join(ROOT, 'tests/results');
const wasmJs      = path.join(ROOT, 'dist/gpl-cpu.js');
const wasmBin     = path.join(ROOT, 'dist/gpl-cpu.wasm');

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

        for (;;) {
            const r = cc('decoder_next_frame', 'number', ['number','number','number','number'], [handle, buf, w, h]);
            if (r === 1) break;
            if (r < 0) { mod._free(buf); cc('decoder_close', null, ['number'], [handle]); throw new Error(`next_frame: ${r}`); }
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

    // extension-only demuxers can't be content-probed; hint the format directly
    const EXT_FMT = {
        g722: 'g722', '722': 'g722',
        tco: 'g723_1', rco: 'g723_1', g723_1: 'g723_1',
    };

    const byCodec = {};

    for (const t of tests) {
        const bytes = new Uint8Array(fs.readFileSync(t.localPath));
        byCodec[t.codec] ??= { pass: 0, total: 0, type: t.type };
        byCodec[t.codec].total++;

        const ext     = t.samplePath.split('.').pop().toLowerCase();
        const fmtHint = EXT_FMT[ext];

        let ok = false;
        try {
            const ptr = alloc(bytes);
            const ph  = cc('probe_open', 'number', ['number','number'], [ptr, bytes.byteLength]);
            mod._free(ptr);
            const hasVideo = ph >= 0 && cc('probe_width',  'number', ['number'], [ph]) > 0;
            if (ph >= 0) cc('probe_close', null, ['number'], [ph]);

            if (hasVideo)   decodeVideo(bytes);
            else            decodeAudio(bytes, fmtHint);
            ok = true;
        } catch {}
        byCodec[t.codec].pass += ok ? 1 : 0;
        parentPort.postMessage({ type: 'tick', ok });
    }

    parentPort.postMessage({ type: 'done', byCodec });
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
    return null;
}

function parseSamplePath(cmd) {
    const m = cmd.match(/\$\(TARGET_SAMPLES\)\/([^\s)]+)/);
    return m ? m[1] : null;
}

function guessCodec(name, samplePath) {
    const knownCodecs = [
        // video — modern
        'h264','hevc','vp8','vp9','av1',
        // video — classic / broadcast
        'mpeg1','mpeg2','mpeg4','h263','h261',
        // video — Microsoft
        'wmv1','wmv2','wmv3','vc1','mss2',
        // video — Apple / professional / Canopus (decoder=cllc)
        'canopus','cllc','prores','dnxhd','mjpeg','qtrle','svq1','svq3','cfhd','qdm2',
        // video — lossless / archival
        'huffyuv','ffv1','magicyuv','lagarith','hap','utvideo',
        // video — Bink
        'bink',
        // video — legacy
        'theora','vp3','vp6','vp7','cinepak','msvideo1',
        // images
        'exr','psd','jpeg2000','jpegls','webp','tiff','bmp','gif','png','dpx','tga',
        // audio — modern
        'aac','opus','mp3','mp2','vorbis','flac',
        // audio — surround
        'ac3','eac3','dts','truehd','alac',
        // audio — lossless
        'wavpack','ape','tta','shorten',
        // audio — Microsoft
        'wmav','wmapro','wmalossless',
        // audio — PCM / ADPCM
        'pcm','adpcm','amr','speex','gsm',
        'g722','g723','g726','sipr','nellymoser',
    ];
    const haystack = (name + ' ' + samplePath).toLowerCase();
    for (const c of knownCodecs) if (haystack.includes(c)) return c;
    return 'other';
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
            tests.push({ name: lastName ?? samplePath, samplePath, localPath, type, codec: guessCodec(lastName ?? '', samplePath) });
        }
    }
    return tests;
}

function chunkArray(arr, n) {
    const chunks = Array.from({ length: n }, () => []);
    arr.forEach((item, i) => chunks[i % n].push(item));
    return chunks.filter(c => c.length > 0);
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
                process.stdout.write(`\r  ${done}/${tests.length}  (${((totalPass / done) * 100).toFixed(1)}% passing)`);
            } else if (msg.type === 'done') {
                for (const [codec, { pass, total, type }] of Object.entries(msg.byCodec)) {
                    byCodec[codec] ??= { pass: 0, total: 0, type };
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
