---
title: Introducing wasmpeg
description: FFmpeg for the browser, built for the decode → display loop — and why we built it.
date: 2026-06-15
author: pocopepe
tag: Announcements
---

This is the first post on the wasmpeg blog. It's a placeholder you can edit or delete —
the blog is wired up and ready for release notes, deep-dives, and announcements.

## Why wasmpeg

Most browser FFmpeg builds aim to be the whole CLI. wasmpeg aims at one thing: the
**decode → display loop**. Load a video, get RGBA frames, scale them on the GPU, probe
metadata, grab thumbnails — from a 2.9 MB gzipped WASM, with no SharedArrayBuffer and no
COOP/COEP headers required.

```js
import wasmpeg from 'wasmpeg';

await wasmpeg.load();

const dec = await wasmpeg.decode(file);
let frame;
while ((frame = dec.nextFrame())) {
    // frame is a Uint8ClampedArray of RGBA8 pixels
}
dec.close();
```

## What's next

Release notes and technical write-ups will land here. For now, head to the
[documentation](/start/introduction/) to get started, or browse the
[FFmpeg → wasmpeg recipes](/guides/ffmpeg-recipes/).
