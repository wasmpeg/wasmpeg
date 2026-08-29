---
title: "Node.js"
description: "Use wasmpeg server-side in Node — decode, probe, extract audio, and generate thumbnails from files, buffers, or URLs, with the same API as the browser."
weight: 50
---
The same API runs in Node 18 or newer — no browser, no native addons, no separate build to
install. Node has no WebGPU adapter, so the CPU build is always used and the `.wasm` is read
from disk by the loader; the bundled binary resolves on its own, so you don't pass `wasmPath`.

## Setup

{{< steps >}}
{{% step %}}
The project must be ESM, since wasmpeg ships ESM only. Set `"type": "module"` in
   `package.json`, or give your entry file an `.mjs` extension. Then install:

   ```sh
   npm install wasmpeg
   ```
{{% /step %}}
{{% step %}}
Probe and decode a file. Read it off disk into a `Uint8Array` and hand that to wasmpeg:

   ```js
   import wasmpeg from 'wasmpeg';
   import { readFile } from 'node:fs/promises';

   await wasmpeg.load();

   const bytes = await readFile('clip.mp4');

   const info = await wasmpeg.probe(bytes);
   console.log(info.duration, info.video.width, info.video.height);

   const dec = await wasmpeg.decode(bytes);
   let count = 0;
   for (let frame; (frame = dec.nextFrame()); ) count++;
   dec.close();
   console.log('decoded', count, 'frames');
   ```
{{% /step %}}
{{< /steps >}}

`nextFrame()` returns each frame as RGBA8 pixels (`Uint8ClampedArray`, width × height × 4
bytes), or `null` at end of stream. `probe()` gives you format, duration, bitrate, the stream
list, and video/audio details without decoding anything.

## Inputs

In Node the inputs are byte buffers or URLs — there's no `File` or canvas:

- A `Uint8Array` or `ArrayBuffer`, typically from `fs.readFile`.
- An `http(s)` URL string, which wasmpeg fetches for you before decoding.

```js
// From a URL
const dec = await wasmpeg.decode('https://example.com/clip.mp4');
```

## Generate a thumbnail to disk

`encode` reads a source, pulls frames, and writes an encoded container — all in memory. Cap
it at one frame for a thumbnail and write the result with `fs`:

```js

await wasmpeg.load();
const bytes = await readFile('clip.mp4');

const jpg = await wasmpeg.encode(bytes, {
    codec: 'mjpeg',
    width: 640,
    height: 360,
    frames: 1,
});
await writeFile('thumb.jpg', jpg);
```

`encode` opens and closes its own decoder and encoder, so there's nothing to clean up after
it returns. `width`/`height` default to the source dimensions; `frames` caps how many frames
are read (omit it to encode the whole clip).

## Extract audio samples

`decodeAudio()` returns interleaved 32-bit float samples. Pull chunks until it returns
`null`:

```js

await wasmpeg.load();
const bytes = await readFile('clip.mp4');

const aud = await wasmpeg.decodeAudio(bytes);
console.log(aud.channels, 'channels at', aud.sampleRate, 'Hz');

let total = 0;
for (let chunk; (chunk = aud.nextSamples()); ) total += chunk.length;
aud.close();
console.log('decoded', total, 'samples');
```

Samples are interleaved by channel (L, R, L, R, … for stereo), so the per-channel count is
`total / aud.channels`.

## Reuse the module across requests

In a server, load once at startup and share the module — don't call `load()` per request.
Caching the promise makes the call safe to await from anywhere:

```js

const ready = wasmpeg.load();

http.createServer(async (req, res) => {
    await ready;

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bytes = Buffer.concat(chunks);

    const jpg = await wasmpeg.encode(bytes, { codec: 'mjpeg', frames: 1 });
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(jpg);
}).listen(3000);
```

{{< aside type="caution" >}}
Close every decoder and audio decoder you open. They hold session slots and native buffers;
under concurrent load, leaked sessions will eventually be exhausted and new opens will fail.
`encode` and `probe` manage their own resources, so those need no manual cleanup.
{{< /aside >}}

## Notes

- **No GPU.** `gpu.hasWebGPU()` is always `false` in Node; scaling runs through `libswscale`
  on the CPU.
- **CommonJS?** The package is ESM-only. From a CJS module, use a dynamic import:
  `const { default: wasmpeg } = await import('wasmpeg');`
- **Heavy work blocks the event loop.** Each `nextFrame()` is synchronous CPU work. For
  large jobs in a server, run decoding in a `worker_threads` worker so request handling stays
  responsive — the API is the same there.

## Related

- [Probe metadata](/docs/guides/probe/) · [Decode audio](/docs/guides/decode-audio/) ·
  [Encode & thumbnails](/docs/guides/encode/) · [High-level reference](/docs/reference/high-level/)
