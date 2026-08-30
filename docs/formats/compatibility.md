---
title: "Compatibility (FATE)"
description: "Live decode compatibility — measured against FFmpeg's own FATE suite on two axes, coverage and byte-for-byte correctness, charted per codec."
weight: 30
---
wasmpeg is tracked against FFmpeg's **FATE** regression suite — the same samples FFmpeg uses
to test itself — on two axes:

- **Coverage** — does a sample decode without erroring? (`tests/compat.mjs` → `COMPAT.md`)
- **Correctness** — does every decoded frame match FFmpeg's reference output **byte-for-byte**?
  (`tests/fate.mjs` → `CORRECTNESS.md`)

Correctness is the number that matters: not "does it run," but "does it produce the exact
right pixels." The figures below are read from those reports at build time, so they track the
repository.

{{< compatreport >}}

## Why FATE

FATE is FFmpeg's own regression suite — the set of real-world and synthetic samples its
maintainers use to catch decode regressions. Testing wasmpeg against the same samples means
the bar is FFmpeg's bar, not one we picked to flatter the numbers. The vendored reference
output that correctness compares against comes straight from FFmpeg, so a passing
correctness test means wasmpeg agrees with upstream FFmpeg on that exact file.

## What "coverage" means

A coverage test passes if the sample **decodes without erroring** — the demuxer opens it, the
decoder accepts every packet, and frames come out. It says nothing about whether those frames
are *correct*; it's the "does it run" bar. High coverage means you can throw real-world files
at wasmpeg and expect them to play.

## What "correctness" means

A correctness test is far stricter: every decoded frame's checksum must be **byte-identical**
to FFmpeg's own reference output. One off-by-one pixel anywhere in the clip fails the whole
test. This is the bar that tells you wasmpeg produces the *same* image FFmpeg would — the
number that actually matters for anything pixel-sensitive (thumbnails, frame extraction,
visual diffing).

Correctness is only measured on pure-decode **video** tests, so its codec list is smaller than
coverage (which includes audio and container handling too).

## Why the two bars differ

A codec can sit at 100% coverage but lower correctness. That's expected and not a red flag —
it usually means the decoder runs end-to-end but diverges on something subtle: chroma
rounding, an uncommon bit-depth, or a profile/feature that isn't fully implemented. The clip
still decodes and looks right to the eye; it just isn't bit-exact.

## Reading the chart

Each bar is a codec's pass rate, colored by how high it is:

- **Emerald (≥95%)** — effectively complete.
- **Sky (≥80%)** — solid, with a few edge cases.
- **Amber (≥50%)** — partial; works for common files, gaps on specific profiles.
- **Rose (below 50%)** — early or limited support.

A low bar almost always points at a *specific feature*, not the whole codec — e.g. one
interlaced profile or a rare pixel format among many that pass. The `pass/total` count next to
each bar shows how many samples that represents.

## Choosing wasmpeg for your codec

1. Find your codec in the **coverage** chart — green or sky means everyday files will decode.
2. If you need exact pixels, check the **correctness** chart for the same codec.
3. A low or missing bar isn't a dead end: try a real sample, and if it fails, open an issue
   with the file — many gaps are narrow and quick to close.

For the full per-test breakdown see
[`COMPAT.md`](https://github.com/wasmpeg/wasmpeg/blob/main/COMPAT.md) and
[`CORRECTNESS.md`](https://github.com/wasmpeg/wasmpeg/blob/main/CORRECTNESS.md) in the repo,
and the [list of compiled codecs](/docs/formats/codecs/) for what's in the build at all.
