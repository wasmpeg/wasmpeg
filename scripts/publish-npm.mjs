#!/usr/bin/env node
// Publishes two npm packages from this one source tree: `@wasmpeg/core` (CPU +
// WebGPU, as checked in) and `@wasmpeg/cpu` (CPU only, smaller download for
// Node/server use where WebGPU never applies). Both stay LGPL — no GPL encoders
// in either.
//
// Usage: node scripts/publish-npm.mjs [--dry-run]

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const dryRun = process.argv.includes('--dry-run');
const original = readFileSync('package.json', 'utf8');
const pkg = JSON.parse(original);

// --provenance needs OIDC (GitHub Actions via Trusted Publishing) — skip it for
// a local/manual publish, where there's no OIDC token to attest with.
const provenance = process.env.CI ? ' --provenance' : '';

function publish(name, files, extraDescription) {
    const variant = { ...pkg, name, files, description: `${pkg.description}${extraDescription}` };
    writeFileSync('package.json', JSON.stringify(variant, null, 2) + '\n');
    console.log(`\n==> publishing ${name}@${pkg.version}${dryRun ? ' (dry run)' : ''}`);
    execSync(`npm publish --access public${provenance}${dryRun ? ' --dry-run' : ''}`, { stdio: 'inherit' });
}

try {
    publish('@wasmpeg/core', ['src/js/', 'dist/cpu.js', 'dist/cpu.wasm', 'dist/webgpu.js', 'dist/webgpu.wasm', 'LICENSE', 'NOTICE'], '');
    publish('@wasmpeg/cpu', ['src/js/', 'dist/cpu.js', 'dist/cpu.wasm', 'LICENSE', 'NOTICE'], ' (CPU-only build, no WebGPU binary — smaller download for Node/server use)');
} finally {
    writeFileSync('package.json', original);
}
