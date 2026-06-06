/**
 * fate.mjs — FATE integration tests against the full FFmpeg sample suite.
 *
 * For each supported sample in fate-suite, decodes the first frame with both
 * the WASM build and native ffmpeg, then compares pixel-by-pixel.
 *
 * Run:  node tests/fate.mjs
 * Env:  FATE_SAMPLES=/path/to/fate-suite  (default: ~/fate-suite)
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { spawnSync }     from 'child_process';
import path from 'path';
import fs   from 'fs';
import os   from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');
const require   = createRequire(import.meta.url);
const FATE_DIR  = process.env.FATE_SAMPLES || path.join(os.homedir(), 'fate-suite');

const SUPPORTED_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm']);

let passed = 0, failed = 0, skipped = 0;

function ok(label, cond) {
    if (cond) { console.log(`  PASS  ${label}`); passed++; }
    else       { console.error(`  FAIL  ${label}`); failed++; }
}
function skip(label, reason) {
    console.log(`  SKIP  ${label}  (${reason})`);
    skipped++;
}

function findSamples(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...findSamples(full));
        } else if (SUPPORTED_EXTS.has(path.extname(entry.name).toLowerCase())) {
            out.push(full);
        }
    }
    return out;
}

function nativeFirstFrame(filePath, w, h) {
    const tmp = path.join(os.tmpdir(), `fate-ref-${process.pid}.raw`);
    const r = spawnSync('ffmpeg', [
        '-loglevel', 'error',
        '-noautorotate',
        '-i', filePath,
        '-vframes', '1',
        '-vf', `scale=${w}:${h}:flags=bilinear`,
        '-f', 'rawvideo', '-pix_fmt', 'rgba',
        '-y', tmp,
    ], { timeout: 10000 });
    if (r.status !== 0) return null;
    const data = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return new Uint8Array(data.buffer);
}

function computePSNR(a, b) {
    if (a.length !== b.length) return 0;
    const nPixels = a.length / 4;
    let mse = 0;
    for (let i = 0; i < nPixels; i++) {
        const base = i * 4;
        for (let c = 0; c < 3; c++) {
            const d = a[base + c] - b[base + c];
            mse += d * d;
        }
    }
    mse /= nPixels * 3;
    return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
}

async function runTests(name, jsPath) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${name}`);
    console.log(`${'─'.repeat(60)}\n`);

    if (!fs.existsSync(jsPath)) {
        skip(name, 'not built');
        return;
    }

    const factory = require(jsPath);
    let mod;
    try   { mod = await factory(); }
    catch (e) { console.error(`  FAIL  load: ${e.message}`); failed++; return; }

    const ver = mod.ccall('pipeline_version', 'string', [], []);
    console.log(`  FFmpeg ${ver}\n`);

    if (!fs.existsSync(FATE_DIR)) {
        skip('fate-suite', `${FATE_DIR} not found`);
        return;
    }

    const samples = findSamples(FATE_DIR).sort();
    console.log(`  ${samples.length} candidate files\n`);

    let nDecoded = 0, nSkipped = 0, nFailed = 0;

    for (const samplePath of samples) {
        const label = path.relative(FATE_DIR, samplePath);

        const fileBytes = fs.readFileSync(samplePath);
        const srcPtr = mod._malloc(fileBytes.byteLength);
        mod.HEAPU8.set(fileBytes, srcPtr);
        const handle = mod.ccall('decoder_open', 'number',
            ['number', 'number'], [srcPtr, fileBytes.byteLength]);
        mod._free(srcPtr);

        if (handle < 0) {
            skip(label, `unsupported codec/container (${handle})`);
            nSkipped++;
            continue;
        }

        const maxW = mod.ccall('decoder_width',  'number', ['number'], [handle]);
        const maxH = mod.ccall('decoder_height', 'number', ['number'], [handle]);
        const dstPtr = mod._malloc(maxW * maxH * 4);
        const frameRet = mod.ccall('decoder_next_frame', 'number',
            ['number', 'number', 'number', 'number'], [handle, dstPtr, 0, 0]);

        if (frameRet !== 0) {
            mod._free(dstPtr);
            mod.ccall('decoder_close', null, ['number'], [handle]);
            skip(label, `no video frame (${frameRet})`);
            nSkipped++;
            continue;
        }

        const w = mod.ccall('decoder_width',  'number', ['number'], [handle]);
        const h = mod.ccall('decoder_height', 'number', ['number'], [handle]);
        const wasmFrame = new Uint8Array(mod.HEAPU8.buffer, dstPtr, w * h * 4).slice();
        mod._free(dstPtr);
        mod.ccall('decoder_close', null, ['number'], [handle]);

        const refFrame = nativeFirstFrame(samplePath, w, h);
        if (!refFrame) {
            skip(label, 'native ffmpeg could not decode');
            nSkipped++;
            continue;
        }

        const psnr = computePSNR(wasmFrame, refFrame);
        const tag  = `${label}  [${w}x${h}]`;
        const psnrStr = isFinite(psnr) ? `${psnr.toFixed(1)}dB` : 'inf';
        if (psnr >= 30) {
            ok(`${tag}  PSNR=${psnrStr}`, true);
            nDecoded++;
        } else {
            console.error(`  FAIL  ${tag}  PSNR=${psnrStr}`);
            failed++;
            nFailed++;
        }
    }

    console.log(`\n  decoded ${nDecoded} files, ${nSkipped} skipped, ${nFailed} pixel mismatches`);
}

await runTests('CPU build',    path.join(ROOT, 'dist/cpu.js'));
await runTests('WebGPU build', path.join(ROOT, 'dist/webgpu.js'));

console.log(`\n${'─'.repeat(60)}`);
console.log(`  ${passed + failed + skipped} total — ${passed} passed  ${failed} failed  ${skipped} skipped`);
console.log(`${'─'.repeat(60)}\n`);
process.exit(failed > 0 ? 1 : 0);
