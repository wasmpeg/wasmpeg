import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const siteDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoDir = dirname(siteDir);

function parseTable(md, columns) {
  const rows = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("|---") || line.includes("Codec")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length !== columns.length) continue;
    const row = {};
    columns.forEach((col, i) => {
      const v = cells[i];
      row[col] = /^[\d.]+%?$/.test(v) ? Number(v.replace("%", "")) : v;
    });
    rows.push(row);
  }
  return rows;
}

function parseMeta(md) {
  const date = md.match(/Last run: \*\*(.+?)\*\*/)?.[1] ?? "";
  const commit = md.match(/commit `(.+?)`/)?.[1] ?? "";
  const overall = md.match(/## Overall: (\d+)\/(\d+) \(([\d.]+)%\)/);
  return {
    date,
    commit,
    pass: overall ? Number(overall[1]) : 0,
    total: overall ? Number(overall[2]) : 0,
    rate: overall ? Number(overall[3]) : 0,
  };
}

const compatMd = readFileSync(join(repoDir, "COMPAT.md"), "utf8");
const correctnessMd = readFileSync(join(repoDir, "CORRECTNESS.md"), "utf8");

const compat = {
  ...parseMeta(compatMd),
  codecs: parseTable(compatMd, ["codec", "type", "pass", "total", "rate"]),
};

const correctness = {
  ...parseMeta(correctnessMd),
  codecs: parseTable(correctnessMd, ["codec", "correct", "total", "rate"]),
};

writeFileSync(join(siteDir, "data", "compat.json"), JSON.stringify(compat, null, 2) + "\n");
writeFileSync(join(siteDir, "data", "correctness.json"), JSON.stringify(correctness, null, 2) + "\n");

console.log(`wrote ${compat.codecs.length} compat rows, ${correctness.codecs.length} correctness rows`);
