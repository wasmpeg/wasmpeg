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
 * Returns { width, height, fps, nextFrame(), close() }.
 */
async function decode(input, { format } = {}) {
    assertLoaded();
    const norm = await normalizeInput(input);
    if (norm.rgba) throw new Error('decode() does not accept raw pixel input — use scale() instead');
    if (norm.fspath) return gpu.createDecoderFile(norm.fspath);
    return gpu.createDecoder(norm.bytes, format);
}

/**
 * Open an audio decoder and return a sample iterator.
 *
 * Returns { channels, sampleRate, nextSamples(), close() }
 * where nextSamples() returns a Float32Array of interleaved f32le samples or null at EOF.
 */
async function decodeAudio(input, { format } = {}) {
    assertLoaded();
    const norm = await normalizeInput(input);
    if (norm.rgba) throw new Error('decodeAudio() does not accept raw pixel input');
    if (norm.fspath) throw new Error('decodeAudio() does not support FS paths yet');
    return gpu.createAudioDecoder(norm.bytes, format);
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
    if (norm.fspath) throw new Error('probe() does not support FS paths yet');
    return gpu.probe(norm.bytes);
}

/**
 * Encode frames or transcode a file.
 *
 * For single-frame image encode (e.g. grab a JPEG thumbnail):
 *   const jpgBytes = await wasmpeg.encode(file, { fmt: 'image2', codec: 'mjpeg', width: 320, height: 240 });
 *
 * opts:
 *   fmt    — container format (e.g. 'image2', 'mp4', 'wav')
 *   codec  — encoder name (e.g. 'mjpeg', 'png', 'aac')
 *   width  — output width (defaults to source width)
 *   height — output height (defaults to source height)
 *   fps    — frame rate as number or { num, den } (default 30)
 *   bitrate — target bitrate bits/s (0 = codec default)
 *   frames — max frames to encode (default: all)
 *
 * Returns a Uint8Array of the encoded container bytes.
 */
async function encode(input, opts = {}) {
    assertLoaded();
    const norm = await normalizeInput(input);

    let srcRgba, srcW, srcH;
    let dec = null;

    if (norm.rgba) {
        srcRgba = norm.rgba;
        srcW    = norm.width;
        srcH    = norm.height;
    } else {
        dec  = norm.fspath
            ? gpu.createDecoderFile(norm.fspath)
            : gpu.createDecoder(norm.bytes, opts.format);
        srcW = opts.width  ?? dec.width;
        srcH = opts.height ?? dec.height;
    }

    const enc = gpu.createEncoder({
        fmt:     opts.fmt   ?? 'image2',
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
                const frame = dec.nextFrame(srcW, srcH);
                if (!frame || frameCount >= maxFrames) break;
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
 * Run an ffmpeg-style command.
 */
async function run(input, args) {
    assertLoaded();
    return exec(input, args);
}

export default { load, scale, decode, decodeAudio, probe, encode, run };
