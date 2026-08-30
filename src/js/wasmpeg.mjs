/**
 * wasmpeg.mjs — simple high-level API.
 *
 * Accepts any JS input type: File, Blob, URL, Uint8Array, ArrayBuffer,
 * HTMLVideoElement, HTMLCanvasElement, ImageData. No manual buffer management,
 * no WASM FS writes, no raw ccall.
 *
 * Usage:
 *   import wasmpeg from 'wasmpeg';
 *   await wasmpeg.load();
 *
 *   const frame  = await wasmpeg.scale(file, 1280, 720);
 *   const dec    = await wasmpeg.decode(file);
 *   const aud    = await wasmpeg.decodeAudio(file);
 *   const info   = await wasmpeg.probe(file);
 *   const output = await wasmpeg.encode(file, { fmt: 'image2', codec: 'mjpeg' });
 */

import { gpu } from './gpu.js';
import { exec, normalizeInput } from './exec.mjs';
import { formatHint } from './formats.js';

let _loaded = false;

async function load(opts = {}) {
    await gpu.load(opts);
    _loaded = true;
}

function assertLoaded() {
    if (!_loaded) throw new Error('call wasmpeg.load() first');
}

/**
 * Scale or filter a frame.
 *
 * Returns a Uint8ClampedArray of RGBA8 pixels (dstW × dstH × 4 bytes).
 */
async function scale(input, dstW, dstH, filter) {
    assertLoaded();
    const fg = filter ?? `scale=${dstW}:${dstH}`;
    return exec(input, ['-vf', fg]);
}

/**
 * Open a video decoder and return a frame iterator.
 *
 * Pass `format` to force a demuxer; otherwise it's inferred from the source
 * filename for formats that don't content-probe (see formats.js).
 *
 * Returns { width, height, fps, nextFrame(), close() }.
 */
async function decode(input, { format } = {}) {
    assertLoaded();
    const norm = await normalizeInput(input);
    if (norm.rgba) throw new Error('decode() does not accept raw pixel input — use scale() instead');
    if (norm.fspath) return gpu.createDecoderFile(norm.fspath);
    return gpu.createDecoder(norm.bytes, format ?? formatHint(norm.name));
}

/**
 * Open an audio decoder and return a sample iterator.
 *
 * Pass `format` to force a demuxer; otherwise it's inferred from the source
 * filename (see formats.js).
 *
 * Returns { channels, sampleRate, nextSamples(), close() }
 * where nextSamples() returns a Float32Array of interleaved f32le samples or null at EOF.
 */
async function decodeAudio(input, { format } = {}) {
    assertLoaded();
    const norm = await normalizeInput(input);
    if (norm.rgba) throw new Error('decodeAudio() does not accept raw pixel input');
    // No audio_open_file export exists, so read the path out of the virtual FS
    // and go through the byte path instead of refusing.
    const bytes = norm.fspath ? gpu.FS.readFile(norm.fspath) : norm.bytes;
    return gpu.createAudioDecoder(bytes, format ?? formatHint(norm.name));
}

/**
 * Probe a media file and return its metadata without decoding frames.
 *
 * Returns:
 *   {
 *     format: string,          // container name (e.g. "mov,mp4,m4a,3gp,3g2,mj2")
 *     duration: number|null,   // duration in seconds, null if unknown
 *     bitrate: number,         // overall bitrate in kb/s
 *     streams: [{ index, type }],  // type is "video", "audio", "subtitle", etc.
 *     video: { width, height, fpsNum, fpsDen },
 *     audio: { sampleRate, channels },
 *   }
 */
async function probe(input) {
    assertLoaded();
    const norm = await normalizeInput(input);
    if (norm.rgba) throw new Error('probe() does not accept raw pixel input');
    return gpu.probe(norm.fspath ? gpu.FS.readFile(norm.fspath) : norm.bytes);
}

/**
 * Encode frames to an image or media container.
 *
 * This is an encode path, not a transcode path: it pulls RGBA frames from the
 * input and re-encodes them. It does not remux or copy streams.
 *
 * For single-frame image encode (e.g. grab a JPEG thumbnail):
 *   const jpgBytes = await wasmpeg.encode(file, { fmt: 'image2', codec: 'mjpeg', width: 320, height: 240 });
 *
 * A frame you already have — e.g. from `dec.nextFrame()` — can be passed directly too;
 * it's a `Uint8ClampedArray`, same as `canvas`/`ImageData` are under the hood, so no
 * DOM is required and this also works in Node:
 *   const jpg = await wasmpeg.encode(frame, { width: dec.width, height: dec.height });
 *
 * opts:
 *   fmt    — container format (e.g. 'image2', 'mp4', 'wav')
 *   codec  — encoder name (e.g. 'mjpeg', 'png', 'aac')
 *   width  — output width (source width; required when input is a raw frame)
 *   height — output height (source height; required when input is a raw frame)
 *   fps    — frame rate as number or { num, den } (default 30)
 *   bitrate — target bitrate bits/s (0 = codec default)
 *   frames — max frames to encode (default: all)
 *
 * Returns a Uint8Array of the encoded container bytes.
 */
async function encode(input, opts = {}) {
    assertLoaded();

    // A raw decoded frame — same shape ImageData.data/canvas readback already
    // produce, just without a DOM object wrapping it. dec.nextFrame() returns
    // exactly this type, so encoding a frame you already have shouldn't need
    // a browser-only ImageData/canvas detour (and can't in Node — ImageData
    // isn't a global there). Shaped like normalizeInput's own rgba results so
    // it flows through the same path below.
    let norm;
    if (input instanceof Uint8ClampedArray) {
        if (!opts.width || !opts.height) {
            throw new Error('encode(): a raw frame needs opts.width and opts.height');
        }
        norm = { rgba: input, width: opts.width, height: opts.height };
    } else {
        norm = await normalizeInput(input);
    }

    let srcRgba, srcW, srcH;
    let dec = null;

    if (norm.rgba) {
        srcRgba = norm.rgba;
        srcW    = norm.width;
        srcH    = norm.height;
    } else {
        dec  = norm.fspath
            ? gpu.createDecoderFile(norm.fspath)
            : gpu.createDecoder(norm.bytes, opts.format ?? formatHint(norm.name));
        srcW = opts.width  ?? dec.width;
        srcH = opts.height ?? dec.height;
    }

    const enc = gpu.createEncoder({
        // image2pipe writes a single stream to our in-memory IO; image2 wants
        // numbered files on a real filesystem and can't be used here.
        fmt:     opts.fmt   ?? 'image2pipe',
        codec:   opts.codec ?? 'mjpeg',
        width:   srcW,
        height:  srcH,
        fps:     opts.fps   ?? 30,
        bitrate: opts.bitrate ?? 0,
    });

    try {
        let ptsMs    = 0;
        const fpsDen = typeof opts.fps === 'object' ? opts.fps.den : 1;
        const fpsNum = typeof opts.fps === 'object' ? opts.fps.num : (opts.fps ?? 30);
        const frameMs = Math.round((fpsDen / fpsNum) * 1000);
        const maxFrames = opts.frames ?? Infinity;
        let frameCount = 0;

        if (norm.rgba) {
            enc.pushRgba(norm.rgba, srcW, srcH, 0);
        } else {
            for (;;) {
                // Check the budget before decoding, not after: the old order
                // decoded one frame past `frames` and threw it away.
                if (frameCount >= maxFrames) break;
                const frame = dec.nextFrame(srcW, srcH);
                if (!frame) break;
                enc.pushRgba(frame, srcW, srcH, ptsMs);
                ptsMs += frameMs;
                frameCount++;
            }
        }

        return enc.finish();
    } finally {
        enc.close();
        if (dec) dec.close();
    }
}

/**
 * Decode the audio of an input and re-encode it.
 *
 *   const flac = await wasmpeg.encodeAudio(file, { fmt: 'flac', codec: 'flac' });
 *
 * opts:
 *   fmt     — container/muxer (default 'wav')
 *   codec   — encoder name (default 'pcm_s16le')
 *   bitrate — target bitrate in bits/s (0 = codec default)
 *   format  — force the input demuxer
 *
 * Returns a Uint8Array of the encoded container bytes.
 */
async function encodeAudio(input, opts = {}) {
    assertLoaded();
    const dec = await decodeAudio(input, { format: opts.format });
    const enc = gpu.createAudioEncoder({
        fmt:        opts.fmt   ?? 'wav',
        codec:      opts.codec ?? 'pcm_s16le',
        sampleRate: dec.sampleRate,
        channels:   dec.channels,
        bitrate:    opts.bitrate ?? 0,
    });
    try {
        let chunk;
        while ((chunk = dec.nextSamples())) enc.pushPcm(chunk);
        return enc.finish();
    } finally {
        enc.close();
        dec.close();
    }
}

/**
 * Run an ffmpeg-style command.
 */
async function run(input, args) {
    assertLoaded();
    return exec(input, args);
}

export default { load, scale, decode, decodeAudio, probe, encode, encodeAudio, run };
