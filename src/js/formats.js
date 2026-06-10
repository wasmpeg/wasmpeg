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
