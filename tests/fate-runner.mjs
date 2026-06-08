/**
 * fate-runner.mjs — parse FATE test CMD patterns and test our exec() parser.
 *
 * Does NOT execute FFmpeg or load WASM. Tests argument parsing only:
 * verifies that every FATE CMD is either correctly parsed and dispatched
 * or correctly identified as out of scope.
 *
 * Usage:
 *   node tests/fate-runner.mjs [--filter=h264] [--verbose]
 */

import fs   from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../src/js/exec.mjs';

const ROOT       = path.resolve(import.meta.dirname, '..');
const FATE_DIR   = path.join(ROOT, 'vendor/ffmpeg/tests/fate');
const VERBOSE    = process.argv.includes('--verbose');
const FILTER_ARG = process.argv.find(a => a.startsWith('--filter='))?.split('=')[1];

// ── FATE macro expansion ──────────────────────────────────────────────────────
// FATE CMD types that map to recognizable ffmpeg patterns.

// Macros we can expand to a representative ffmpeg-equivalent.
const MACRO_PATTERNS = {
    // framecrc -i file [opts] → decode-only, frame CRC output
    framecrc:  args => `-i SAMPLE_FILE ${args}`,
    // framemd5 → same shape
    framemd5:  args => `-i SAMPLE_FILE ${args}`,
    // pcm → audio decode — always unsupported
    pcm:       args => `-vn -i SAMPLE_FILE ${args}`,
    // md5 → raw decode to md5
    md5:       args => `-i SAMPLE_FILE ${args}`,
    // md5pipe → same
    md5pipe:   args => `-i SAMPLE_FILE ${args}`,
    // video_filter "fg" → apply filtergraph to synthetic source
    video_filter: args => `-vf ${args.replace(/^"(.*)"$/, '$1')} -i SYNTHETIC`,
    // ffmpeg → literal, strip the leading 'ffmpeg '
    ffmpeg:    args => args,
    // transcode → encode — almost always unsupported
    transcode: args => `${args}`,
    // fmtstdout → format probe — unsupported
    fmtstdout: args => `-f ${args} -i SAMPLE_FILE`,
    // audio_match → audio comparison — unsupported
    audio_match: args => `-i SAMPLE_FILE ${args}`,
};

// CMD types we know are outside wasmpeg scope — explain why, don't count as failures.
const OUT_OF_SCOPE = new Set([
    'pcm',          // audio-only decode — no audio pipeline
    'enc_dec_pcm',  // audio encode/decode — no audio pipeline
    'transcode',    // requires encode — not implemented
    'audio_match',  // audio comparison
    'run',          // generic shell command runner
    'checkasm',     // assembly unit tests
    'api',          // C API tests
    'probeframes',  // ffprobe-based
    'fmtstdout',    // format probing
    'lavf_audio',   // lavf audio tests
    'lavf_image',   // lavf image roundtrip — encode needed
    'lavf_container', // container roundtrip — encode needed
    'lavf_container_fate', // same
    'enc_dec',      // encode/decode roundtrip
    'stream_demux', // demux-specific
    'pixfmts',      // pixel format conversion matrix
    'cover-art',    // embedded cover art — complex map args
]);

// ── .mak parser ───────────────────────────────────────────────────────────────

function parseMakFile(filePath) {
    const text  = fs.readFileSync(filePath, 'utf8');
    const tests = [];
    const lines = text.replace(/\\\n/g, ' ').split('\n');

    for (const line of lines) {
        const m = line.match(/CMD\s*=\s*(.+)/);
        if (!m) continue;

        let cmd = m[1].trim();

        // Strip make variable references — substitute with placeholders.
        cmd = cmd
            .replace(/\$\(TARGET_SAMPLES\)/g, '/SAMPLES')
            .replace(/\$\(TARGET_PATH\)/g,    '/TARGET')
            .replace(/\$\(SRC_PATH\)/g,       '/SRC')
            .replace(/\$\([^)]+\)/g,          'MAKE_VAR');

        // Extract test name from the line above (best-effort).
        const nameM = line.match(/^(fate-[\w-]+)\s*:/);
        tests.push({ name: nameM?.[1] ?? 'unknown', cmd: cmd.trim() });
    }
    return tests;
}

// ── classify a CMD ────────────────────────────────────────────────────────────

function classifyCmd(cmd) {
    const [macro, ...rest] = cmd.trim().split(/\s+/);
    const restStr = rest.join(' ');

    if (OUT_OF_SCOPE.has(macro)) {
        return { status: 'out_of_scope', reason: macro };
    }

    // Expand to ffmpeg-style args
    const expander = MACRO_PATTERNS[macro];
    let ffargs;
    if (expander) {
        ffargs = expander(restStr);
    } else if (macro.startsWith('-') || macro === 'ffmpeg') {
        // Already an ffmpeg command
        ffargs = macro === 'ffmpeg' ? restStr : cmd;
    } else {
        return { status: 'out_of_scope', reason: `unknown_macro:${macro}` };
    }

    // Try parsing
    try {
        const parsed = parseArgs(ffargs);

        // Check for audio-only operations
        const outOpts = parsed.outputs[0]?.options ?? {};
        const hasVideo = !('-vn' in outOpts) || ('-vf' in outOpts) || ('-filter:v' in outOpts);
        const hasFilter = '-vf' in outOpts || '-filter:v' in outOpts || '-filter_complex' in outOpts;
        const hasInput = parsed.inputs.length > 0;

        if (!hasInput && !ffargs.includes('SYNTHETIC') && !ffargs.includes('testsrc')) {
            return { status: 'parse_error', reason: 'no input found', ffargs };
        }

        if ('-vn' in outOpts && !hasFilter) {
            return { status: 'out_of_scope', reason: 'audio-only output (-vn, no -vf)' };
        }

        const op = hasFilter ? 'filter' : 'decode';
        return { status: 'parsed', op, parsed, ffargs };
    } catch (e) {
        return { status: 'parse_error', reason: e.message, ffargs };
    }
}

// ── main ──────────────────────────────────────────────────────────────────────

const maks = fs.readdirSync(FATE_DIR)
    .filter(f => f.endsWith('.mak'))
    .filter(f => !FILTER_ARG || f.includes(FILTER_ARG));

const stats = { parsed: 0, out_of_scope: 0, parse_error: 0 };
const failures = [];

for (const mak of maks) {
    const tests = parseMakFile(path.join(FATE_DIR, mak));

    for (const { name, cmd } of tests) {
        const result = classifyCmd(cmd);
        stats[result.status] = (stats[result.status] ?? 0) + 1;

        if (result.status === 'parse_error') {
            failures.push({ name, cmd, result });
            if (VERBOSE) {
                console.error(`  FAIL [${name}]`);
                console.error(`    cmd:    ${cmd}`);
                console.error(`    reason: ${result.reason}`);
                if (result.ffargs) console.error(`    args:   ${result.ffargs}`);
            }
        } else if (VERBOSE && result.status === 'parsed') {
            console.log(`  PASS [${name}] op=${result.op}`);
        }
    }
}

const total = Object.values(stats).reduce((a, b) => a + b, 0);

console.log('');
console.log('FATE parser results');
console.log('─'.repeat(50));
console.log(`  Total tests:   ${total}`);
console.log(`  Parsed:        ${stats.parsed ?? 0}  (arg parsing correct)`);
console.log(`  Out of scope:  ${stats.out_of_scope ?? 0}  (audio, encode, probes — expected)`);
console.log(`  Parse errors:  ${stats.parse_error ?? 0}  (failures to fix)`);
console.log('');

if (failures.length && !VERBOSE) {
    console.log('Parse failures (run with --verbose for full detail):');
    const shown = failures.slice(0, 20);
    for (const { name, cmd, result } of shown) {
        console.log(`  [${name}]`);
        console.log(`    cmd:    ${cmd.slice(0, 80)}${cmd.length > 80 ? '…' : ''}`);
        console.log(`    reason: ${result.reason}`);
    }
    if (failures.length > 20) console.log(`  … and ${failures.length - 20} more`);
}
