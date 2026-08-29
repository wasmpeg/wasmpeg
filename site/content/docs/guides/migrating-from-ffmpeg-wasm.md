---
title: "Migrating from @ffmpeg/ffmpeg"
description: "Move an existing ffmpeg.wasm project to wasmpeg — what maps directly, the one behavioral difference (no output files), and how to rework exec()."
weight: 80
---
wasmpeg ships an [`FFmpeg` class](/docs/reference/ffmpeg-class/) shaped like `@ffmpeg/ffmpeg`
v0.12, so most setup code ports with minimal edits. The one thing you must rework is anything
that reads an **output file** back from `exec()`.

## What maps directly

```js

const ff = new FFmpeg();
ff.on('log', ({ message }) => console.log(message));
await ff.load();

await ff.writeFile('input.mp4', data);
```

`new FFmpeg()`, `load()`, `on('log')` / `on('progress')`, `writeFile`, `readFile`,
`deleteFile`, `createDir`, `listDir`, `exec`, and `terminate` all exist with the same shapes.

### Method-by-method

| Method | Status | Notes |
|--------|--------|-------|
| `new FFmpeg()` | Same | No constructor args. |
| `load()` | Simpler | No `coreURL`/`wasmURL`/`toBlobURL`. Takes an optional `{ wasmPath }`. |
| `on('log', …)` | Same | Receives `{ type, message }`; `type` is `'stdout'` or `'stderr'`. |
| `on('progress', …)` | Partial | Fires `{ progress }` parsed from `time=` in log output; no ratio/total. |
| `off(event, handler)` | Same | Removes a previously registered handler. |
| `writeFile(path, data)` | Same | `Uint8Array` or a `Blob`/`File`. |
| `readFile(path)` | Same | Returns a `Uint8Array` from the virtual FS. |
| `deleteFile` / `createDir` / `listDir` | Same | Thin wrappers over the Emscripten FS. |
| `exec(args)` | **Different** | Decodes and returns data; never writes an output file. |
| `terminate()` | Same | Drops the module and clears listeners. |

The FS methods are real — `writeFile` then `readFile` round-trips bytes — but `exec()` reads
its `-i` input from the FS and returns the decode result rather than writing an output path
back into it. That's the one behavioral change to plan around.

## What's simpler

- **No `toBlobURL` / core URLs.** wasmpeg bundles its WASM; just `import` it. There's no
  separate core package to fetch and wire up.
- **No COOP/COEP headers, no SharedArrayBuffer.** It runs on any static host on the main
  thread. You can delete your cross-origin-isolation server config.
- **Smaller.** A focused decode-first build (~{{% param "sizeGzMB" %}} MB gzipped CPU).

## The one breaking difference: no output files

`@ffmpeg/ffmpeg`'s `exec()` writes an output file you read back:

```js
// @ffmpeg/ffmpeg — writes out.mp4 to the virtual FS
await ffmpeg.exec(['-i', 'input.mp4', '-vf', 'scale=1280:720', 'out.mp4']);
const data = await ffmpeg.readFile('out.mp4');
```

wasmpeg's `exec()` runs the **decode + filter** pipeline and **returns the result directly** —
it does not mux an output file:

```js
// wasmpeg — returns RGBA pixels of the (first) filtered frame
const rgba = await ff.exec(['-i', 'input.mp4', '-vf', 'scale=1280:720']);
// use rgba (Uint8ClampedArray) directly; there is no out.mp4 to read
```

{{< aside type="caution" >}}
Any `exec([...]); readFile('out.*')` pattern must be rewritten to consume `exec()`'s return
value. A decode-only command returns a [Decoder](/docs/reference/high-level/#decoder-object); a
filter command returns RGBA pixels.
{{< /aside >}}

### What exec() returns, by command shape

`exec()` decides what to give you from the flags, not from the output filename (which it
ignores):

| Command shape | Return value |
|---------------|--------------|
| `['-i', 'in', '-vf', 'scale=…']` | RGBA pixels (`Uint8ClampedArray`) of the first filtered frame |
| `['-i', 'in', '-s', 'WxH']` | Same — `-s` is shorthand for `scale=W:H` |
| `['-i', 'in']` (no filter) | A `Decoder` — iterate `nextFrame()`, then `close()` |
| `['-i', 'in', '-vn']` or `['-i', 'in', '-af', '…']` | An `AudioDecoder` — iterate `nextSamples()`, then `close()` |

So the rewrite depends on what the old command did. A `scale` command's output file becomes the
returned pixel array; a plain decode's output frames become a decoder you loop over and must
`close()`. Both replace `readFile()` entirely.

{{< aside type="tip" >}}
`exec()` on the `FFmpeg` class and `wasmpeg.run()` are the same dispatcher. If you're already
reworking call sites, `wasmpeg.run(input, args)` skips the FS dance — pass a `File`/`Blob`/URL
straight in instead of `writeFile`-ing it first.
{{< /aside >}}

## Mapping common tasks

| @ffmpeg/ffmpeg | wasmpeg |
|----------------|---------|
| `exec(['-i','in','-frames:v','1','out.jpg'])` then `readFile` | `await wasmpeg.encode(input, { codec: 'mjpeg', frames: 1 })` |
| `exec(['-i','in','-vf','scale=W:H','out.png'])` then `readFile` | `await wasmpeg.scale(input, W, H)` |
| `exec(['-i','in','-vn','out.wav'])` then `readFile` | `await wasmpeg.decodeAudio(input)` (PCM) |
| `ffprobe`-style inspection | `await wasmpeg.probe(input)` |
| `-i in.mp4 out.webm` (transcode) | **Not supported** — use server-side FFmpeg |

For most apps you can skip the `FFmpeg` class entirely and use the
[high-level API](/docs/reference/high-level/), which is purpose-built for these tasks and accepts
`File`/`Blob`/URL/canvas directly.

## A worked rewrite

A typical ffmpeg.wasm thumbnail flow:

```js
// before — @ffmpeg/ffmpeg

const ffmpeg = new FFmpeg();
await ffmpeg.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
});
await ffmpeg.writeFile('in.mp4', await fetchFile(file));
await ffmpeg.exec(['-i', 'in.mp4', '-frames:v', '1', 'out.jpg']);
const jpg = await ffmpeg.readFile('out.jpg');
const url = URL.createObjectURL(new Blob([jpg], { type: 'image/jpeg' }));
```

The wasmpeg version, using the high-level API:

```js
// after — wasmpeg

await wasmpeg.load();
const jpg = await wasmpeg.encode(file, { codec: 'mjpeg', frames: 1 });
const url = URL.createObjectURL(new Blob([jpg], { type: 'image/jpeg' }));
```

No core URLs, no `toBlobURL`, no FS write/read, no manual `fetchFile` — the `File` goes
straight in.

## Progress and log events

`on('log', …)` works the same and receives `{ type, message }` where `type` is `'stdout'` or
`'stderr'`. `on('progress', …)` exists but is best-effort: it fires `{ progress }` parsed from
the `time=` token in log lines, so it won't track a percentage of a transcode the way
ffmpeg.wasm does (there's no transcode to track). For decode loops, your own counter against
`probe().duration` or a frame count is a more reliable progress source.

## Checklist

1. Replace the `@ffmpeg/ffmpeg` + `@ffmpeg/core` install with `npm install wasmpeg`.
2. Swap `import { FFmpeg } from '@ffmpeg/ffmpeg'` → `import { FFmpeg } from 'wasmpeg'`.
3. Delete `toBlobURL`/core-loading and any COOP/COEP server headers.
4. Rework every `exec(); readFile('out.*')` to use the return value (or a high-level method).
5. Confirm there's no file-to-file transcode in your flow — if there is, that part stays
   server-side.

## Related

- [FFmpeg class reference](/docs/reference/ffmpeg-class/) · [Command reference](/docs/reference/exec-commands/)
- [The three APIs](/docs/start/apis/) — the high-level export is usually the better target.
