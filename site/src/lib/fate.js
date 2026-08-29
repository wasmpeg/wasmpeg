// Build-time parser for the repo's FATE reports (COMPAT.md / CORRECTNESS.md).
// These live at the repository root, one level above the site/ directory.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Vite bundles this module for SSR, so import.meta.url can't be relied on to point
// at the source file. process.cwd() is the site/ dir during the build, so the repo
// root is one level up. Try a few candidates and use the first that exists.
function read(name) {
    const candidates = [
        path.resolve(process.cwd(), '..', name), // site/ -> repo root (build)
        path.resolve(process.cwd(), name), // cwd already at repo root
        fileURLToPath(new URL(`../../../${name}`, import.meta.url)), // source-relative (dev)
    ];
    for (const p of candidates) {
        try {
            if (existsSync(p)) return readFileSync(p, 'utf8');
        } catch {
            /* try next */
        }
    }
    return null;
}

function parseOverall(md) {
    const m = md.match(/##\s*Overall:\s*(\d+)\/(\d+)\s*\(([\d.]+)%\)/);
    return m ? { pass: Number(m[1]), total: Number(m[2]), rate: parseFloat(m[3]) } : null;
}

function parseMeta(md) {
    return {
        date: md.match(/Last run:\s*\*\*([^*]+)\*\*/)?.[1]?.trim() ?? null,
        commit: md.match(/commit\s*`([^`]+)`/)?.[1] ?? null,
        wasm: md.match(/WASM\s*\*\*([^*]+)\*\*/)?.[1]?.trim() ?? null,
    };
}

function parseRows(md) {
    const rows = [];
    for (const line of md.split('\n')) {
        if (!line.trim().startsWith('|')) continue;
        const cells = line.split('|').slice(1, -1).map((c) => c.trim());
        if (!cells.length) continue;
        if (cells[0].toLowerCase() === 'codec') continue; // header
        if (/^-+$/.test(cells[0])) continue; // separator
        rows.push(cells);
    }
    return rows;
}

/**
 * Returns parsed FATE stats, or null if the reports aren't reachable at build time.
 * { compat: { pass, total, rate, meta, codecs:[{codec,type,pass,total,rate}] },
 *   correctness: { pass, total, rate, meta, codecs:[{codec,correct,total,rate}] } }
 */
export function readFateStats() {
    const compatMd = read('COMPAT.md');
    const corrMd = read('CORRECTNESS.md');
    if (!compatMd || !corrMd) return null;

    const compat = {
        ...parseOverall(compatMd),
        meta: parseMeta(compatMd),
        codecs: parseRows(compatMd).map((c) => ({
            codec: c[0],
            type: c[1],
            pass: Number(c[2]),
            total: Number(c[3]),
            rate: parseFloat(c[4]),
        })),
    };
    const correctness = {
        ...parseOverall(corrMd),
        meta: parseMeta(corrMd),
        codecs: parseRows(corrMd).map((c) => ({
            codec: c[0],
            correct: Number(c[1]),
            total: Number(c[2]),
            rate: parseFloat(c[3]),
        })),
    };
    return { compat, correctness };
}
