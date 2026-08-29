// Generates public/og.png (1200×630) — the social share image.
// Run from the site/ directory: `node scripts/gen-og.mjs`
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/og.png');

const svg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#38bdf8"/>
      <stop offset="1" stop-color="#67e8f9"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#a3a3a3"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="#0a0a0a"/>
  <rect width="1200" height="4" fill="url(#sky)" opacity="0.7"/>
  <g font-family="Helvetica, Arial, sans-serif">
    <g transform="translate(80,92)">
      <rect x="0" y="-22" width="34" height="34" rx="8" fill="#111111" stroke="#ffffff" stroke-opacity="0.16"/>
      <text x="4" y="4" font-size="22" font-weight="700" fill="#fafafa">w</text>
      <text x="52" y="6" font-size="26" font-weight="600" fill="#fafafa" letter-spacing="-0.5">wasmpeg</text>
    </g>
    <text x="78" y="300" font-size="82" font-weight="700" fill="url(#fade)" letter-spacing="-2">Decode video</text>
    <text x="78" y="392" font-size="82" font-weight="700" letter-spacing="-2"><tspan fill="url(#fade)">in the </tspan><tspan fill="url(#sky)">browser.</tspan></text>
    <text x="80" y="468" font-size="30" fill="#a1a1a1" letter-spacing="-0.3">RGBA frames, audio &amp; metadata from a 2.9 MB gzipped WASM.</text>
    <text x="80" y="556" font-size="24" font-weight="600" fill="#38bdf8" letter-spacing="0.5">wasmpeg.pages.dev</text>
    <text x="1120" y="556" font-size="22" fill="#525252" text-anchor="end" letter-spacing="0.5">LGPL-2.1</text>
  </g>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(out);
console.log('wrote', out);
