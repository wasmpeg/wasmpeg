#!/usr/bin/env node
/**
 * configure.mjs — build configurator for wasmpeg.
 *
 * Usage:
 *   node src/cli/configure.mjs             (interactive)
 *   node src/cli/configure.mjs --preset=minimal --target=webgpu --build
 */

import { execSync, spawnSync } from 'child_process';
import { createInterface }     from 'readline';
import { fileURLToPath }       from 'url';
import path                    from 'path';
import fs                      from 'fs';

const ROOT   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VENDOR = path.join(ROOT, 'vendor/ffmpeg');
const DIST   = path.join(ROOT, 'dist');

// ── codec presets ─────────────────────────────────────────────────────────────

const PRESETS = {
    // Fast iteration build — smallest output, modern web codecs only.
    minimal: {
        decoders:  ['h264', 'vp8', 'aac', 'opus', 'mp3'],
        encoders:  ['aac', 'mjpeg', 'png'],
        demuxers:  ['mov', 'matroska', 'ogg', 'mp3', 'h264', 'hevc', 'image2', 'image2pipe', 'image_png_pipe'],
        muxers:    ['mp4', 'webm', 'ogg', 'image2', 'null'],
        parsers:   ['h264', 'vp8', 'aac', 'opus', 'png'],
        protocols: ['file'],
        filters:   ['scale', 'crop', 'overlay', 'aresample', 'hstack', 'vstack', 'format'],
        desc: 'Fast dev build — H264/VP8 decode, AAC/MJPEG/PNG encode',
    },

    // wasmpeg — LGPL-2.1-or-later. Safe to embed in commercial products.
    // All codecs are FFmpeg built-ins; no external library required.
    lgpl: {
        gpl: false,
        decoders: [
            // modern web video
            'h264', 'hevc', 'vp8', 'vp9', 'av1',
            // classic / broadcast video
            'mpeg1video', 'mpeg2video', 'mpeg4', 'h263', 'h261',
            // Microsoft
            'msmpeg4v1', 'msmpeg4v2', 'msmpeg4v3', 'wmv1', 'wmv2', 'wmv3', 'vc1',
            // Apple
            'prores', 'qtrle', 'svq1', 'svq3',
            // professional
            'dnxhd', 'mjpeg', 'mjpegb',
            // lossless / archival
            'huffyuv', 'ffv1', 'ffvhuff', 'utvideo',
            // legacy
            'theora', 'vp3', 'vp6f', 'vp7', 'rv10', 'rv20', 'rv30', 'rv40',
            'flashsv', 'flashsv2', 'cinepak', 'msvideo1',
            // images
            'png', 'gif', 'bmp', 'tiff', 'webp', 'tga', 'dpx', 'xbm',
            'jpeg2000', 'jpegls',
            // modern audio
            'aac', 'aac_latm', 'opus', 'mp3', 'mp2', 'mp1', 'vorbis', 'flac',
            // surround / professional audio
            'ac3', 'eac3', 'dca', 'truehd', 'mlp',
            // lossless audio
            'alac', 'wavpack', 'ape', 'tta', 'shorten',
            // Microsoft audio
            'wmav1', 'wmav2', 'wmapro', 'wmalossless',
            // PCM variants
            'pcm_s8', 'pcm_s16le', 'pcm_s16be', 'pcm_s24le', 'pcm_s32le',
            'pcm_f32le', 'pcm_f64le', 'pcm_mulaw', 'pcm_alaw', 'pcm_dvd',
            // ADPCM
            'adpcm_ms', 'adpcm_ima_wav', 'adpcm_ima_qt',
            'adpcm_swf', 'adpcm_yamaha', 'adpcm_thp',
            // other audio
            'speex', 'nellymoser', 'amrnb', 'amrwb',
            'g722', 'g723_1', 'g726', 'gsm', 'gsm_ms',
            'atrac1', 'atrac3', 'atrac3p', 'sipr',
        ],
        encoders: [
            // video
            'mjpeg', 'png', 'gif', 'bmp', 'tiff', 'tga', 'dpx',
            'huffyuv', 'ffv1',
            // audio
            'aac', 'opus', 'flac', 'mp2', 'wavpack',
            'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_mulaw', 'pcm_alaw',
            'adpcm_ms', 'adpcm_ima_wav',
        ],
        demuxers: [
            // major containers
            'mov', 'matroska', 'avi', 'ogg', 'asf', 'flv', 'rm',
            // audio containers
            'mp3', 'wav', 'flac', 'aac', 'ac3', 'dts', 'truehd', 'mlp',
            'amr', 'g722', 'g726', 'gsm',
            // raw bitstreams
            'h264', 'hevc', 'vp8', 'vp9', 'av1',
            'mpeg', 'mpegvideo', 'mpegts', 'rawvideo', 'm4v',
            // image sequences
            'image2', 'image2pipe', 'image_png_pipe',
            // other
            'concat', 'wtv', 'pcm_s16le', 'pcm_s16be', 'pcm_f32le',
            'pcm_mulaw', 'pcm_alaw',
        ],
        muxers: [
            'mp4', 'webm', 'ogg', 'matroska', 'avi', 'flv', 'asf',
            'mpegts', 'wav', 'flac', 'ac3', 'adts', 'opus', 'truehd',
            'image2', 'null',
            'pcm_s16le', 'pcm_f32le', 'pcm_mulaw', 'pcm_alaw',
        ],
        parsers: [
            'h264', 'hevc', 'vp8', 'vp9', 'av1',
            'mpeg4video', 'h263', 'vc1', 'dvbsub', 'dvdsub',
            'aac', 'aac_latm', 'ac3', 'dca', 'flac', 'opus',
            'mpegaudio', 'png',
        ],
        protocols: ['file'],
        filters: [
            'scale', 'crop', 'overlay', 'aresample',
            'hstack', 'vstack', 'format', 'transpose', 'rotate',
            'pad', 'trim', 'setpts', 'fps', 'split', 'colorspace',
            'eq', 'hue', 'curves', 'colorbalance', 'colorchannelmixer',
            'noise', 'unsharp', 'boxblur', 'gblur',
            'yadif', 'bwdif', 'deinterlace',
            'volume', 'atrim', 'asetpts', 'amerge', 'amix', 'aecho',
            'highpass', 'lowpass', 'equalizer',
            'concat', 'null', 'anull',
        ],
        desc: 'wasmpeg — comprehensive LGPL build, safe for commercial use',
    },

    // wasmpeg-full — GPL-2.0-or-later.
    // Adds H.264 and H.265 encoding via libx264/libx265.
    // Requires external libs; see docs/building.md#gpl-build.
    // NOTE: linking this binary into a closed-source product requires GPL compliance.
    gpl: {
        gpl: true,
        // inherits all lgpl codecs — extended below after PRESETS is defined
        decoders: [],
        encoders: [],
        demuxers: [],
        muxers:   [],
        parsers:  [],
        protocols: ['file'],
        filters:  [],
        extraFlags: [
            '--enable-gpl',
            // external libs — uncomment once cross-compiled (see docs/building.md)
            // '--enable-libx264',
            // '--enable-libx265',
        ],
        extraEncoders: [
            // 'libx264',
            // 'libx265',
        ],
        desc: 'wasmpeg-full — GPL build, adds H.264/H.265 encode (libx264/libx265)',
    },

    // Fast iteration — keep for dev speed
    standard: {
        decoders:  ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'aac', 'opus',
                    'mp3', 'vorbis', 'png', 'mjpeg', 'gif', 'flac'],
        encoders:  ['aac', 'opus', 'flac', 'mjpeg', 'png', 'gif'],
        demuxers:  ['mov', 'matroska', 'ogg', 'mp3', 'wav',
                    'h264', 'hevc', 'vp8', 'vp9',
                    'image2', 'image2pipe', 'image_png_pipe', 'concat', 'flac'],
        muxers:    ['mp4', 'webm', 'ogg', 'image2', 'wav', 'null', 'flac'],
        parsers:   ['h264', 'hevc', 'vp8', 'vp9', 'aac', 'opus', 'png'],
        protocols: ['file'],
        filters:   ['scale', 'crop', 'overlay', 'aresample', 'hstack', 'vstack', 'format',
                    'transpose', 'rotate', 'pad', 'trim', 'setpts', 'fps', 'split', 'colorspace'],
        desc: 'Standard dev build — broad decode, common filters',
    },
};

// GPL preset inherits everything from lgpl and extends it
Object.assign(PRESETS.gpl, {
    decoders:  [...PRESETS.lgpl.decoders],
    encoders:  [...PRESETS.lgpl.encoders, ...PRESETS.gpl.extraEncoders],
    demuxers:  [...PRESETS.lgpl.demuxers],
    muxers:    [...PRESETS.lgpl.muxers],
    parsers:   [...PRESETS.lgpl.parsers],
    filters:   [...PRESETS.lgpl.filters],
});

// ── arg parsing ───────────────────────────────────────────────────────────────

const args = Object.fromEntries(
    process.argv.slice(2)
        .filter(a => a.startsWith('--'))
        .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

// ── readline helper ───────────────────────────────────────────────────────────

async function ask(rl, question, fallback) {
    return new Promise(resolve => {
        rl.question(`${question} [${fallback}]: `, ans => {
            resolve(ans.trim() || fallback);
        });
    });
}

// ── generate configure flags ──────────────────────────────────────────────────

function buildFlags(preset, webgpu) {
    const p = PRESETS[preset];
    const flags = [
        '--target-os=none', '--arch=x86_32', '--enable-cross-compile',
        '--disable-x86asm', '--disable-inline-asm', '--disable-stripping',
        '--disable-ffplay', '--disable-ffprobe', '--disable-doc',
        '--disable-debug', '--disable-runtime-cpudetect', '--disable-autodetect',
        '--enable-small', '--disable-pthreads', '--disable-network',
        '--disable-everything',
        '--enable-zlib',
        '--enable-avcodec', '--enable-avformat', '--enable-avfilter',
        '--enable-avutil', '--enable-swscale', '--enable-swresample',
        ...(p.extraFlags ?? []),
        ...p.decoders.map(c => `--enable-decoder=${c}`),
        ...p.encoders.map(c => `--enable-encoder=${c}`),
        ...p.demuxers.map(c => `--enable-demuxer=${c}`),
        ...p.muxers.map(c  => `--enable-muxer=${c}`),
        ...p.parsers.map(c => `--enable-parser=${c}`),
        ...p.protocols.map(x => `--enable-protocol=${x}`),
        ...p.filters.map(f => `--enable-filter=${f}`),
    ];
    if (webgpu) {
        flags.push('--enable-webgpu', '--enable-filter=scale_webgpu');
    }
    return flags;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\nwasmpeg build configurator');
    console.log('─'.repeat(40));

    let preset  = args.preset;
    let target  = args.target;
    let doBuild = args.build === true;

    if (!preset || !target) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });

        if (!preset) {
            console.log('\nPresets:');
            for (const [name, p] of Object.entries(PRESETS))
                console.log(`  ${name.padEnd(10)} ${p.desc}`);
            preset = await ask(rl, '\nPreset', 'minimal');
            if (!PRESETS[preset]) { console.error(`Unknown preset: ${preset}`); process.exit(1); }
        }

        if (!target) {
            target = await ask(rl, 'Target  (cpu / webgpu / both)', 'both');
        }

        const confirm = await ask(rl, '\nRun configure + build now? (y/n)', 'n');
        doBuild = confirm.toLowerCase() === 'y';
        rl.close();
    }

    const targets = target === 'both' ? ['cpu', 'webgpu'] : [target];
    const p = PRESETS[preset];

    console.log('\nWill build:');
    console.log(`  preset:   ${preset}`);
    console.log(`  targets:  ${targets.join(', ')}`);
    console.log(`  decoders: ${p.decoders.join(', ')}`);
    console.log(`  encoders: ${p.encoders.join(', ')}`);
    console.log(`  filters:  ${p.filters.concat(targets.includes('webgpu') ? ['scale_webgpu'] : []).join(', ')}`);

    for (const t of targets) {
        const webgpu     = t === 'webgpu';
        const prefix     = path.join(ROOT, `build-${t}`);
        const flags      = buildFlags(preset, webgpu);
        const scriptName = `configure-${t}.sh`;
        const script     = path.join(ROOT, scriptName);

        const extraCflags  = webgpu ? '-O3 --use-port=emdawnwebgpu' : '-O3 -msimd128';
        const extraLdflags = webgpu
            ? '-O3 --use-port=emdawnwebgpu -s ASYNCIFY -s INITIAL_MEMORY=67108864'
            : '-O3 -lz';

        const content = [
            '#!/bin/bash',
            `# Generated by src/cli/configure.mjs — ${new Date().toISOString()}`,
            'set -e',
            '',
            `cd "${VENDOR}"`,
            `emconfigure ./configure \\`,
            `    ${flags.join(' \\\n    ')} \\`,
            `    --prefix=${prefix} \\`,
            '    --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib \\',
            '    --disable-shared --enable-static \\',
            `    --extra-cflags="${extraCflags}" \\`,
            '    --extra-cxxflags="-O3" \\',
            `    --extra-ldflags="${extraLdflags}"`,
            '',
        ].join('\n');

        fs.writeFileSync(script, content, { mode: 0o755 });
        console.log(`\n  wrote ${scriptName}`);

        if (doBuild) {
            console.log(`\n  configuring ${t}...`);
            const nproc = process.platform === 'darwin'
                ? execSync('sysctl -n hw.ncpu').toString().trim()
                : execSync('nproc').toString().trim();

            const r = spawnSync('bash', ['-c',
                `bash "${script}" && cd "${VENDOR}" && emmake make -j${nproc} install`],
                { stdio: 'inherit' });
            if (r.status !== 0) { console.error(`configure-${t} failed`); process.exit(1); }
            console.log(`  ${t} libraries built.`);
        }
    }

    if (!doBuild) {
        console.log('\nTo build manually, run:');
        for (const t of targets)
            console.log(`  bash configure-${t}.sh && cd vendor/ffmpeg && emmake make install`);
    }

    console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
