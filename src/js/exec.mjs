/**
 * exec.mjs — ffmpeg command parser and wasmpeg dispatcher.
 *
 * Accepts a JS input (File, Blob, URL, Uint8Array, HTMLVideoElement,
 * HTMLCanvasElement, ImageData) and an ffmpeg args string or array,
 * and routes to the appropriate wasmpeg pipeline calls.
 */

import { gpu } from './gpu.js';

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

        if (tok === '-i') {
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
 *   { bytes: Uint8Array }                              — encoded file
 *   { rgba: Uint8ClampedArray, width, height }         — raw pixels
 */
export async function normalizeInput(input) {
    if (input == null) throw new Error('input is null or undefined');

    if (input instanceof Uint8Array)  return { bytes: input };
    if (input instanceof ArrayBuffer) return { bytes: new Uint8Array(input) };

    // Blob / File
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
        return { bytes: new Uint8Array(await input.arrayBuffer()) };
    }

    // URL string
    if (typeof input === 'string' && (input.startsWith('http://') || input.startsWith('https://'))) {
        const res = await fetch(input);
        if (!res.ok) throw new Error(`fetch ${input} failed: ${res.status} ${res.statusText}`);
        return { bytes: new Uint8Array(await res.arrayBuffer()) };
    }

    // WASM FS path — pass straight through, caller uses decoder_open_file
    if (typeof input === 'string' && input.startsWith('/')) {
        return { fspath: input };
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

// Extract output dimensions from a filtergraph string.
// Returns { w, h } if determinable, null otherwise.
function fgDimensions(fg) {
    // scale=W:H or scale=w=W:h=H
    const m = fg.match(/(?:^|,)scale(?:_webgpu)?=(?:w=)?(\d+)(?::h=|:)(\d+)/);
    if (m) return { w: parseInt(m[1]), h: parseInt(m[2]) };
    return null;
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
    const outOpts = parsed.outputs[0]?.options ?? {};

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
        return gpu.createAudioDecoder(norm.bytes);
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
            srcW    = dec.width;
            srcH    = dec.height;
            srcRgba = dec.nextFrame();
            if (!srcRgba) throw new Error('input stream is empty — no frames decoded');
            dec.close();
            dec = null;
        }

        // Determine output dimensions
        let dstW = srcW, dstH = srcH;
        if (filtergraph) {
            const dims = fgDimensions(filtergraph);
            if (dims) { dstW = dims.w; dstH = dims.h; }
        }

        return gpu.scale(srcRgba, srcW, srcH, dstW, dstH, filtergraph ?? `scale=${dstW}:${dstH}`);
    }

    // ── decode-only — return decoder ─────────────────────────────────────────
    if (dec) return dec;

    throw new Error(`exec: could not determine operation from args: ${JSON.stringify(parsed)}`);
}
