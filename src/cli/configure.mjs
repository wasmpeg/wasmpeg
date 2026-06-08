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
    minimal: {
        decoders:  ['h264', 'vp8', 'aac', 'opus', 'mp3'],
        encoders:  ['aac', 'mjpeg', 'png'],
        demuxers:  ['mov', 'matroska', 'ogg', 'mp3', 'h264', 'hevc', 'image2', 'image2pipe', 'image_png_pipe'],
        muxers:    ['mp4', 'webm', 'ogg', 'image2', 'null'],
        parsers:   ['h264', 'vp8', 'aac', 'opus', 'png'],
        protocols: ['file'],
        filters:   ['scale', 'crop', 'overlay', 'aresample', 'hstack', 'vstack', 'format'],
        desc: 'H264/VP8 decode, AAC/MJPEG/PNG encode, basic filters',
    },
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
        desc: 'Broad decode support, safe native encoders, common filters',
    },
};

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
