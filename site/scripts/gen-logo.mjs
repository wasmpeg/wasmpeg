// Generates square PNG logos for use as a GitHub org / social avatar.
// Outputs public/logo-1024.png and public/logo-512.png.
// Run from the site/ directory: `node scripts/gen-logo.mjs`
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

// The brand mark (the wasmpeg "w" + chevron), centered on a dark square with the
// sky accent. GitHub masks avatars, so the art is full-bleed with internal padding.
const svg = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="50%" cy="32%" r="80%">
      <stop offset="0" stop-color="#15171c"/>
      <stop offset="1" stop-color="#0a0a0a"/>
    </radialGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <g transform="translate(96,96) scale(26)">
    <path d="M6 11l2.4 10h2.2L13 13.6 15.4 21h2.2L20 11h-2.2l-1.5 6.8L14.1 11h-2.2l-2.2 6.8L8.2 11H6z" fill="#fafafa"/>
    <path d="M22 11.5l4 4.5-4 4.5" stroke="#38bdf8" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </g>
</svg>`;

const buf = Buffer.from(svg);
await sharp(buf).png().toFile(path.join(dir, 'logo-1024.png'));
await sharp(buf).resize(512, 512).png().toFile(path.join(dir, 'logo-512.png'));
console.log('wrote', path.join(dir, 'logo-1024.png'), '+ logo-512.png');
