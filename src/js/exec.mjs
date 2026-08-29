/**
 * exec.mjs — ffmpeg command parser and wasmpeg dispatcher.
 *
 * Accepts a JS input (File, Blob, URL, Uint8Array, HTMLVideoElement,
 * HTMLCanvasElement, ImageData) and an ffmpeg args string or array,
 * and routes to the appropriate wasmpeg pipeline calls.
 */

import { gpu } from './gpu.js';
import { formatHint } from './formats.js';

// ── flags ─────────────────────────────────────────────────────────────────────

// Flags that consume the next token as their value.
// Includes stream-specifier variants: -c:v, -filter:v:0, etc.
const VALUE_FLAGS = new Set([
    '-i', '-f', '-t', '-ss', '-to', '-sseof',
    '-vf', '-af', '-filter_complex', '-lavfi',
    '-s', '-r', '-ar', '-ac',
    '-c', '-vcodec', '-acodec', '-scodec',
    '-b', '-minrate', '-maxrate', '-bufsize',
    '-pix_fmt', '-sample_fmt',
    '-vframes', '-aframes',
    '-map', '-map_metadata', '-map_chapters',
    '-preset', '-crf', '-g', '-keyint_min', '-bf',
    '-aspect', '-atag', '-vtag',
    '-metadata', '-disposition',
    '-loglevel', '-v',
    '-threads', '-filter_threads',
    '-stream_loop', '-itsoffset', '-itsscale',
    '-frames', '-q', '-qscale',
    '-profile', '-level',
    '-bsf', '-bsf:v', '-bsf:a',
    '-vsync', '-async',
    '-sws_flags', '-flags', '-flags2',
    '-fflags', '-err_detect',
    '-max_error_rate',
    '-downmix',
    '-framerate',
    '-trans_color',
]);

// Flags with no value.
const BOOL_FLAGS = new Set([
    '-y', '-n', '-nostdin', '-hide_banner', '-benchmark',
    '-an', '-vn', '-sn',
    '-copyinkf', '-noaccurate_seek',
    '-accurate_seek', '-shortest',
    '-re', '-copyts', '-start_at_zero',
    '-auto_conversion_filters',
    // Without these the unknown-flag heuristic below eats the next token, which
    // is usually the output filename.
    '-nostats', '-stats', '-dn', '-ignore_unknown', '-bitexact',
    '-autorotate', '-noautorotate', '-xerror', '-fix_sub_duration',
    '-vstats', '-noautoscale',
]);

// Flags ffmpeg treats as global wherever they appear, rather than binding to
// the next input or output.
const GLOBAL_FLAGS = new Set([
    '-y', '-n', '-hide_banner', '-nostdin', '-nostats', '-stats',
    '-loglevel', '-v', '-benchmark', '-ignore_unknown', '-xerror', '-bitexact',
]);

// ── tokenizer ─────────────────────────────────────────────────────────────────

function tokenize(str) {
    const tokens = [];
    let cur = '';
    let quote = null;

    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (quote) {
            if (ch === quote) quote = null;
            else cur += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '\\' && i + 1 < str.length) {
            cur += str[++i];
        } else if (ch === ' ' || ch === '\t' || ch === '\n') {
            if (cur) { tokens.push(cur); cur = ''; }
        } else {
            cur += ch;
        }
    }
    if (cur) tokens.push(cur);
    return tokens;
}

// ── arg parser ────────────────────────────────────────────────────────────────

/**
 * Parse an ffmpeg args array into a structured object.
 *
 * Returns:
 *   {
 *     inputs:  [{ url: string, options: Object }],
 *     outputs: [{ url: string, options: Object }],
 *     global:  Object,
 *   }
 */
export function parseArgs(args) {
    if (typeof args === 'string') args = tokenize(args);

    const result  = { inputs: [], outputs: [], global: {} };
    let   pending = {};   // options accumulating before next -i or output

    const isFlag = tok => tok.startsWith('-') && tok.length > 1 && isNaN(Number(tok));

    // Normalize flag: strip stream specifier suffix for lookup, keep original.
    const baseFlag = tok => {
        // -c:v → -c, -filter:v:0 → -filter, -frames:v → -frames
        const colon = tok.indexOf(':', 1);
        return colon !== -1 ? tok.slice(0, colon) : tok;
    };

    for (let i = 0; i < args.length; i++) {
        const tok = args[i];

        if (!isFlag(tok)) {
            // Positional: output URL
            result.outputs.push({ url: tok, options: pending });
            pending = {};
            continue;
        }

        const base = baseFlag(tok);

        if (GLOBAL_FLAGS.has(tok) || GLOBAL_FLAGS.has(base)) {
            // Value-taking globals (-loglevel, -v) still consume their argument.
            result.global[tok] = (VALUE_FLAGS.has(tok) || VALUE_FLAGS.has(base))
                ? (args[++i] ?? '')
                : true;
        } else if (tok === '-i') {
            result.inputs.push({ url: args[++i], options: pending });
            pending = {};
        } else if (VALUE_FLAGS.has(tok) || VALUE_FLAGS.has(base)) {
            pending[tok] = args[++i] ?? '';
        } else if (BOOL_FLAGS.has(tok) || BOOL_FLAGS.has(base)) {
            pending[tok] = true;
        } else if (isFlag(tok)) {
            // Unknown flag — consume value if next token looks like a value.
            const next = args[i + 1];
            if (next !== undefined && !isFlag(next)) {
                pending[tok] = args[++i];
            } else {
                pending[tok] = true;
            }
        }
    }

    // Leftover pending options with no output → attach to global
    if (Object.keys(pending).length) {
        Object.assign(result.global, pending);
    }

    return result;
}

// ── input normalization ───────────────────────────────────────────────────────

/**
 * Accept any JS input type and return one of:
 *   { bytes: Uint8Array, name? }                       — encoded file
 *   { rgba: Uint8ClampedArray, width, height }         — raw pixels
 *   { fspath: string, name }                           — WASM FS path
 *
 * `name` is the source filename or path when known (File.name, a URL's
 * pathname, an FS path). The decoder API uses it to derive a format hint.
 */
export async function normalizeInput(input) {
    if (input == null) throw new Error('input is null or undefined');

    if (input instanceof Uint8Array)  return { bytes: input };
    if (input instanceof ArrayBuffer) return { bytes: new Uint8Array(input) };

    // Blob / File — File carries a .name, a plain Blob does not.
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
        return { bytes: new Uint8Array(await input.arrayBuffer()), name: input.name };
    }

    // URL string
    if (typeof input === 'string' && (input.startsWith('http://') || input.startsWith('https://'))) {
        const res = await fetch(input);
        if (!res.ok) throw new Error(`fetch ${input} failed: ${res.status} ${res.statusText}`);
        let name;
        try { name = new URL(input).pathname; } catch {}
        return { bytes: new Uint8Array(await res.arrayBuffer()), name };
    }

    // WASM FS path — pass straight through, caller uses decoder_open_file
    if (typeof input === 'string' && input.startsWith('/')) {
        return { fspath: input, name: input };
    }

    // HTMLVideoElement
    if (typeof HTMLVideoElement !== 'undefined' && input instanceof HTMLVideoElement) {
        const w = input.videoWidth, h = input.videoHeight;
        if (!w || !h) throw new Error('video element has no dimensions — is it loaded?');
        const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
        canvas.getContext('2d').drawImage(input, 0, 0);
        const id = canvas.getContext('2d').getImageData(0, 0, w, h);
        return { rgba: id.data, width: w, height: h };
    }

    // HTMLCanvasElement
    if (typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement) {
        const id = input.getContext('2d').getImageData(0, 0, input.width, input.height);
        return { rgba: id.data, width: input.width, height: input.height };
    }

    // ImageData
    if (typeof ImageData !== 'undefined' && input instanceof ImageData) {
        return { rgba: input.data, width: input.width, height: input.height };
    }

    throw new Error(`Unsupported input type: ${input?.constructor?.name ?? typeof input}`);
}

// ── filtergraph helpers ───────────────────────────────────────────────────────

// Parse -s WxH or W:H into { w, h }
function parseSize(s) {
    const m = String(s).match(/^(\d+)[x:](\d+)$/i);
    if (!m) throw new Error(`cannot parse size: ${s}`);
    return { w: parseInt(m[1]), h: parseInt(m[2]) };
}

// Evaluate one scale= dimension expression against the source size.
// Supports plain numbers, iw/ih (in_w/in_h) and arithmetic over them. Anything
// outside that character set is rejected rather than evaluated.
function evalDimExpr(expr, srcW, srcH) {
    const e = String(expr).trim()
        .replace(/\b(?:in_w|iw)\b/g, String(srcW))
        .replace(/\b(?:in_h|ih)\b/g, String(srcH));
    if (!/^[0-9+\-*/(). ]+$/.test(e)) return null;
    try {
        const v = Function(`"use strict";return (${e});`)();
        return Number.isFinite(v) ? v : null;
    } catch { return null; }
}

// Extract output dimensions from a filtergraph string.
// Returns { w, h } if determinable, null otherwise.
function fgDimensions(fg, srcW = 0, srcH = 0) {
    // scale=W:H or scale=w=W:h=H, where either side may be an expression.
    const m = fg.match(/(?:^|,)scale(?:_webgpu)?=(?:w=)?([^:,]+)(?::h=|:)([^:,\]]+)/);
    if (!m) return null;

    let w = evalDimExpr(m[1], srcW, srcH);
    let h = evalDimExpr(m[2], srcW, srcH);
    if (w === null || h === null) return null;

    // A negative value means "preserve aspect, rounded to a multiple of |n|".
    const fit = (n, known, srcKnown, srcOther) => {
        const mult = Math.abs(n) || 1;
        if (!srcKnown) return null;
        const exact = (known * srcOther) / srcKnown;
        return Math.max(mult, Math.round(exact / mult) * mult);
    };
    if (w < 0 && h > 0)      w = fit(w, h, srcH, srcW);
    else if (h < 0 && w > 0) h = fit(h, w, srcW, srcH);

    if (!(w > 0 && h > 0)) return null;
    return { w: Math.round(w), h: Math.round(h) };
}

// Wrap a decoder so it reports end of stream after n frames (-vframes/-frames).
function limitFrames(dec, n) {
    let seen = 0;
    return {
        width:  dec.width,
        height: dec.height,
        fps:    dec.fps,
        nextFrame(...args) { return seen++ < n ? dec.nextFrame(...args) : null; },
        close() { dec.close(); },
    };
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/**
 * exec(input, args) — parse ffmpeg args and dispatch to wasmpeg pipeline.
 *
 * @param {*}             input  - Any supported input type (see normalizeInput).
 * @param {string|Array}  args   - ffmpeg arg string or array.
 * @returns {Uint8ClampedArray|Object}
 *   For filter ops: Uint8ClampedArray of RGBA pixels.
 *   For decode-only: a Decoder object with .nextFrame() / .close().
 */
export async function exec(input, args) {
    await gpu.load();

    const parsed = parseArgs(args);
    // Options apply whether or not an output file is named: `-vf scale=…` with no
    // output token lands in `global`, while `-i in -vf scale=… out.png` lands in
    // the output's options. Merge both so either form works.
    const outOpts = { ...parsed.global, ...(parsed.outputs[0]?.options ?? {}) };

    // ── resolve video filter ──────────────────────────────────────────────────
    const vf = outOpts['-vf'] ?? outOpts['-filter:v'];
    const sizeStr = outOpts['-s'];

    let filtergraph = vf ?? null;

    // -s WxH is shorthand for scale=W:H
    if (!filtergraph && sizeStr) {
        const { w, h } = parseSize(sizeStr);
        filtergraph = `scale=${w}:${h}`;
    }

    // ── audio filter / audio-only → route to audio decoder ───────────────────
    const af = outOpts['-af'] ?? outOpts['-filter:a'];
    if (af || ('-vn' in outOpts && !filtergraph)) {
        const norm = await normalizeInput(input);
        if (norm.rgba)   throw new Error('audio output requires a media file input, not raw pixels');
        if (norm.fspath) throw new Error('audio output from WASM FS path is not yet supported');
        // Same hinting the high-level decodeAudio() applies: several game and
        // legacy audio containers carry no magic bytes and only probe by name.
        return gpu.createAudioDecoder(norm.bytes, formatHint(norm.name));
    }

    const norm = await normalizeInput(input);

    // ── open decoder ──────────────────────────────────────────────────────────
    let dec;
    if (norm.rgba) {
        // Already pixels — no decoder needed
    } else if (norm.fspath) {
        dec = gpu.createDecoderFile(norm.fspath);
    } else {
        dec = gpu.createDecoder(norm.bytes);
    }

    // ── filter operation ──────────────────────────────────────────────────────
    if (filtergraph || norm.rgba) {
        let srcRgba, srcW, srcH;

        if (norm.rgba) {
            srcRgba = norm.rgba;
            srcW    = norm.width;
            srcH    = norm.height;
        } else {
            // Close in a finally: a decode error here would otherwise strand one
            // of the eight session slots, and a few failures exhaust the pool.
            try {
                srcW    = dec.width;
                srcH    = dec.height;
                srcRgba = dec.nextFrame();
                if (!srcRgba) throw new Error('input stream is empty — no frames decoded');
            } finally {
                dec.close();
                dec = null;
            }
        }

        // Determine output dimensions
        let dstW = srcW, dstH = srcH;
        if (filtergraph) {
            const dims = fgDimensions(filtergraph, srcW, srcH);
            if (dims) { dstW = dims.w; dstH = dims.h; }
        }

        return gpu.scale(srcRgba, srcW, srcH, dstW, dstH, filtergraph ?? `scale=${dstW}:${dstH}`);
    }

    // ── decode-only — return decoder ─────────────────────────────────────────
    if (dec) {
        // -vframes N / -frames:v N cap the stream length.
        const key   = Object.keys(outOpts).find(k => k === '-vframes' || k.startsWith('-frames'));
        const limit = key ? parseInt(outOpts[key], 10) : NaN;
        return Number.isInteger(limit) && limit > 0 ? limitFrames(dec, limit) : dec;
    }

    throw new Error(`exec: could not determine operation from args: ${JSON.stringify(parsed)}`);
}
