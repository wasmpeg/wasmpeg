// Shared between tests/compat.mjs and tests/fate.mjs: path resolution, the
// .mak scanner, codec guessing, and a watchdog-enabled worker runner so a
// stalled test can't hang the whole run.

import { Worker } from 'node:worker_threads';
import fs   from 'node:fs';
import path from 'node:path';

export function resolvePaths(rootDir) {
    const ROOT        = rootDir;
    const SAMPLES_DIR = process.env.FATE_SAMPLES ?? path.join(ROOT, 'fate-suite');
    const FATE_DIR     = path.join(ROOT, 'vendor/ffmpeg/tests/fate');
    const REF_DIR      = path.join(ROOT, 'vendor/ffmpeg/tests/ref/fate');
    const RESULTS_DIR  = path.join(ROOT, 'tests/results');
    const WASM_BUILD   = process.env.WASM_BUILD ?? 'gpl-cpu';   // e.g. WASM_BUILD=cpu
    return {
        ROOT, SAMPLES_DIR, FATE_DIR, REF_DIR, RESULTS_DIR, WASM_BUILD,
        wasmJs:  path.join(ROOT, `dist/${WASM_BUILD}.js`),
        wasmBin: path.join(ROOT, `dist/${WASM_BUILD}.wasm`),
    };
}

export function parseSamplePath(cmd) {
    const m = cmd.match(/\$\(TARGET_SAMPLES\)\/([^\s)]+)/);
    return m ? m[1] : null;
}

// Union of compat.mjs's and fate.mjs's previously-separate lists — fate.mjs's
// video-only samples now also match the handful of codecs that were only in
// compat's list (canopus, dolby_e, ...), and vice versa (indeo, fraps, cdxl,
// ...), instead of silently falling into "other" depending on which script ran.
const KNOWN_CODECS = [
    // video — modern
    'h264', 'hevc', 'vp8', 'vp9', 'av1',
    // video — classic / broadcast
    'mpeg1', 'mpeg2', 'mpeg4', 'h263', 'h261',
    // video — Microsoft
    'wmv1', 'wmv2', 'wmv3', 'vc1', 'mss2',
    // video — Apple / professional / Canopus
    'canopus', 'cllc', 'prores', 'dnxhd', 'mjpeg', 'qtrle', 'svq1', 'svq3', 'cfhd', 'qdm2',
    // video — lossless / archival
    'huffyuv', 'ffv1', 'magicyuv', 'lagarith', 'hap', 'utvideo',
    // video — Bink / legacy
    'bink', 'theora', 'vp3', 'vp6', 'vp7', 'cinepak', 'msvideo1',
    'indeo', 'loco', 'msrle', 'dv', 'fraps', 'cdxl', 'flic', 'zmbv', 'speedhq', 'qoi', 'avif',
    // images
    'exr', 'psd', 'jpeg2000', 'jpegls', 'webp', 'tiff', 'bmp', 'gif', 'png', 'dpx', 'tga',
    // audio — modern
    'aac', 'opus', 'mp3', 'mp2', 'vorbis', 'flac',
    // audio — surround
    'ac3', 'eac3', 'dts', 'truehd', 'alac',
    // audio — lossless
    'wavpack', 'ape', 'tta', 'shorten',
    // audio — Microsoft
    'wmav', 'wmapro', 'wmalossless',
    // audio — PCM / ADPCM
    'pcm', 'adpcm', 'amr', 'speex', 'gsm',
    'g722', 'g723', 'g726', 'sipr', 'nellymoser',
    // audio — game / multimedia
    'dpcm', 'atrac', 'wmavoice', 'imc', 'truespeech', 'musepack', 'twinvq',
    'qcelp', 'ra4', 'ra_288', 'cook', 'dolby_e', 'dsf', 'g728',
];

export function guessCodec(name, samplePath) {
    const haystack = (name + ' ' + samplePath).toLowerCase();
    for (const c of KNOWN_CODECS) if (haystack.includes(c)) return c;
    return 'other';
}

export function chunkArray(arr, n) {
    const chunks = Array.from({ length: n }, () => []);
    arr.forEach((item, i) => chunks[i % n].push(item));
    return chunks.filter(c => c.length > 0);
}

// Walks every .mak file in fateDir, yielding { name, cmd } for each CMD= line
// alongside the fate-<name>: target it belongs to. Both loadTests()
// implementations filter and shape this differently (compat wants
// framecrc/pcm/etc across both types; fate wants framecrc-only with a
// reference file) — that filtering stays in each script, only the scan itself
// is shared.
export function* scanMakLines(fateDir) {
    for (const mak of fs.readdirSync(fateDir).filter(f => f.endsWith('.mak'))) {
        const text = fs.readFileSync(path.join(fateDir, mak), 'utf8').replace(/\\\n/g, ' ');
        let lastName = null;
        for (const line of text.split('\n')) {
            const nm = line.match(/^(fate-[\w-]+)\s*:/);
            if (nm) lastName = nm[1];
            const cm = line.match(/CMD\s*=\s*(.+)/);
            if (cm) yield { name: lastName, cmd: cm[1].trim() };
        }
    }
}

// Spawns one worker per chunk and resolves once every worker has either sent
// its 'done' message or been killed for going quiet too long.
//
// A stall is real (see ISSUES.local.md #2): a long-lived worker running many
// tests sequentially can hang under memory pressure from concurrent WASM
// instances, with nothing to time it out. When that happens here, the worker
// is terminated and every test it hadn't ticked yet is counted as a timeout
// failure — not silently dropped — so `done` still reaches tests.length and
// the tracked pass rate stays honest about what didn't get verified.
//
// 90s: generous enough that a legitimately slow decode under real contention
// doesn't get misclassified, short enough to bound a hung run to minutes
// instead of forever. The original incident this guards against stalled for
// many minutes with zero progress, not tens of seconds.
//
// byCodec is aggregated here from each 'tick', not from a worker's final
// 'done' payload — a killed worker still contributed accurate ticks for
// whatever it completed before stalling.
export async function runWorkers({ scriptUrl, chunks, extraData = {}, onTick, staleMs = 90_000 }) {
    return new Promise((resolve, reject) => {
        const live = new Map();   // worker -> { chunk, processed, lastActivity }
        let finished = 0;

        const settle = () => { if (++finished === chunks.length) { clearInterval(watchdog); resolve(); } };

        for (const chunk of chunks) {
            const w = new Worker(scriptUrl, { workerData: { tests: chunk, ...extraData } });
            live.set(w, { chunk, processed: 0, lastActivity: Date.now() });

            w.on('message', msg => {
                const info = live.get(w);
                if (!info) return;   // already timed out and terminated
                info.lastActivity = Date.now();
                if (msg.type === 'tick') { info.processed++; onTick(msg); }
                if (msg.type === 'done') { live.delete(w); settle(); }
            });
            w.on('error', reject);
        }

        // A stalled worker's remaining tests are marked failed with the real
        // codec/type pulled from the chunk itself, not dropped — see the
        // module doc comment above for why that matters for accounting.
        const watchdog = setInterval(() => {
            const now = Date.now();
            for (const [w, info] of live) {
                if (now - info.lastActivity <= staleMs) continue;
                live.delete(w);
                w.terminate();
                for (const t of info.chunk.slice(info.processed)) {
                    onTick({ type: 'tick', ok: false, timeout: true, codec: t.codec, sampleType: t.type });
                }
                settle();
            }
        }, 2000);
    });
}
