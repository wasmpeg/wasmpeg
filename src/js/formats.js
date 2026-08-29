/**
 * formats.js — map a filename or path to an FFmpeg demuxer hint.
 *
 * Some container formats can't be identified by content-probing alone (many
 * game and legacy audio formats carry no magic bytes). For those, the file
 * extension or a path fragment is the only reliable signal. The decoder API
 * passes the resulting hint to decoder_open_format / audio_open_format.
 *
 * This is the single source of truth shared by the public API (gpu.js,
 * wasmpeg.mjs) and the FATE harness (tests/compat.mjs), so a real caller and
 * the compatibility score take the same code path.
 */

// Extension → demuxer name for formats that probe unreliably.
export const EXT_FMT = {
    g722: 'g722', '722': 'g722',
    tco: 'g723_1', rco: 'g723_1', g723_1: 'g723_1',
    adp: 'adp', aea: 'aea', apc: 'apc', apm: 'apm',
    brstm: 'brstm', bfstm: 'bfstm', bcstm: 'bcstm',
    iss: 'iss', rsd: 'rsd', sol: 'sol',
    vag: 'kvag', xa: 'xa',
    '5c': 'pp_bnk', '11c': 'pp_bnk', '44c': 'pp_bnk',
    pcm: 'alp', tun: 'alp',
    znm: 'smush', vqf: 'vqf',
    qcp: 'qcp', xwma: 'xwma',
    shn: 'shorten', g728: 'g728', dff: 'dsf',
    thd: 'truehd',
};

// Path fragment → demuxer name, for files with no usable extension
// (e.g. the FATE dolby_e sample named `16-11`).
export const PATH_FMT = [
    [/\/dolby_e\//i, 's337m'],
];

// Extensions that are always video even when the probe reports width 0
// (raw bitstreams the demuxer can't size up front). Used for routing.
export const EXT_VIDEO = new Set(['dnxhr', 'rcv']);

/**
 * Return a demuxer hint for a filename or path, or undefined if none applies.
 * Accepts a bare name, a relative path, or a URL.
 */
export function formatHint(nameOrPath) {
    if (!nameOrPath) return undefined;
    const ext = nameOrPath.split('.').pop()?.toLowerCase();
    return EXT_FMT[ext] ?? PATH_FMT.find(([re]) => re.test(nameOrPath))?.[1];
}

/**
 * Output extension → { fmt, codec } for transcoding.
 *
 * Only formats this build can actually encode are listed. There is no H.264,
 * HEVC, VP8/VP9 or AV1 encoder in the LGPL build, so .mp4/.webm are absent on
 * purpose: naming one should fail with a clear message rather than produce a
 * container the decoder side cannot fill.
 */
export const OUT_FMT = {
    // still images and animation
    gif:  { fmt: 'gif',        codec: 'gif' },
    png:  { fmt: 'image2pipe', codec: 'png' },
    jpg:  { fmt: 'image2pipe', codec: 'mjpeg' },
    jpeg: { fmt: 'image2pipe', codec: 'mjpeg' },
    bmp:  { fmt: 'image2pipe', codec: 'bmp' },
    tif:  { fmt: 'image2pipe', codec: 'tiff' },
    tiff: { fmt: 'image2pipe', codec: 'tiff' },
    tga:  { fmt: 'image2pipe', codec: 'targa' },
    dpx:  { fmt: 'image2pipe', codec: 'dpx' },
    // lossless video
    avi:  { fmt: 'avi',      codec: 'ffv1' },
    mkv:  { fmt: 'matroska', codec: 'ffv1' },
    // audio
    wav:  { fmt: 'wav',  codec: 'pcm_s16le', audio: true },
    flac: { fmt: 'flac', codec: 'flac',      audio: true },
    ogg:  { fmt: 'ogg',  codec: 'opus',      audio: true },
    opus: { fmt: 'ogg',  codec: 'opus',      audio: true },
};

/** Look up an output target by filename. Returns undefined when unsupported. */
export function outputTarget(nameOrPath) {
    if (!nameOrPath) return undefined;
    const ext = nameOrPath.split('.').pop()?.toLowerCase();
    return ext ? OUT_FMT[ext] : undefined;
}
