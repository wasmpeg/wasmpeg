---
title: "Svelte"
description: "Use wasmpeg in a Svelte or SvelteKit app — render a decoded frame to a canvas, keep decoding client-side under SSR, generate thumbnails in a server endpoint, and offload to a worker."
weight: 40
---
wasmpeg works in any Svelte setup. On Vite-based Svelte and SvelteKit the WASM is served
automatically. The one rule under SvelteKit: decoding must run in the browser, so keep it out
of code that executes during SSR.

## Component

{{< steps >}}
{{% step %}}
Install:

   ```sh
   npm install @wasmpeg/core
   ```
{{% /step %}}
{{% step %}}
Decode a frame. `onMount` runs only on the client, which is exactly where decoding
   belongs:

   ```svelte
   <script>
       import { onMount, onDestroy } from 'svelte';
       import wasmpeg from '@wasmpeg/core';

       export let file;
       let canvas;
       let dec;

       onMount(async () => {
           await wasmpeg.load();
           dec = await wasmpeg.decode(file);
           const frame = dec.nextFrame();
           if (!frame) return;
           canvas.width = dec.width;
           canvas.height = dec.height;
           canvas.getContext('2d')
               .putImageData(new ImageData(frame, dec.width, dec.height), 0, 0);
       });

       onDestroy(() => dec?.close());
   </script>

   <canvas bind:this={canvas} />
   ```
{{% /step %}}
{{< /steps >}}

`decode()` accepts a `File` or `Blob` from an input or drop event. Each `nextFrame()` returns
RGBA8 pixels (`Uint8ClampedArray`, width × height × 4), or `null` at the end of the stream.

{{< aside type="caution" >}}
Close the decoder in `onDestroy`. Each open decoder holds a session and native buffers, and
skipping `close()` leaks them across mounts.
{{< /aside >}}

## SvelteKit: keep decoding on the client

{{< aside type="caution" title="Browser-only" >}}
Decoding can't run during SSR. Calling it from `onMount` already keeps it client-side. If you
need to branch on the environment elsewhere, guard with the `browser` flag:

```js

if (browser) {
    await wasmpeg.load();
    // ...decode here
}
```
{{< /aside >}}

## Server-side thumbnails

For thumbnails generated on the server, use a `+server.js` endpoint running on the Node
adapter. The input is request bytes, so pass a `Uint8Array` — `File` and canvas types don't
exist server-side. Caching the load promise keeps the WASM from recompiling on every request:

```js
// src/routes/api/thumb/+server.js

let ready;

export async function POST({ request }) {
    ready ??= wasmpeg.load();
    await ready;

    const bytes = new Uint8Array(await request.arrayBuffer());
    const jpg = await wasmpeg.encode(bytes, {
        codec: 'mjpeg',
        width: 640,
        height: 360,
        frames: 1,
    });

    return new Response(jpg, { headers: { 'Content-Type': 'image/jpeg' } });
}
```

`encode` opens and closes its own decoder and encoder internally, so there's nothing to clean
up after the call. Deploy this on the Node adapter, not an edge target — the loader reads the
`.wasm` through Node's `fs`.

## Offload long decodes to a Worker

Decoding blocks the thread it runs on, so move heavy work into a Web Worker to keep the UI
responsive. The API is identical inside a worker:

```js
// src/lib/decode.worker.js

let ready;
self.onmessage = async (e) => {
    ready ??= wasmpeg.load();
    await ready;
    const dec = await wasmpeg.decode(e.data.file);
    try {
        for (let frame; (frame = dec.nextFrame()); ) {
            self.postMessage({ width: dec.width, height: dec.height, frame }, [frame.buffer]);
        }
    } finally {
        dec.close();
        self.postMessage({ done: true });
    }
};
```

```svelte
<script>
    import DecodeWorker from '$lib/decode.worker.js?worker';
    const worker = new DecodeWorker();
</script>
```

SvelteKit's Vite setup supports the `?worker` import suffix. Transferring `frame.buffer`
hands the pixels to the main thread without a copy.

## If the WASM 404s

Copy the binaries into `static/`, which SvelteKit serves at the site root, then pass the
path:

```sh
cp node_modules/wasmpeg/dist/cpu.* static/wasmpeg/
```

```js
await wasmpeg.load({ wasmPath: '/wasmpeg/cpu.js' });   // cpu.wasm sits beside it
```

## Related

- [Quick start](/docs/start/quick-start/) · [Encode & thumbnails](/docs/guides/encode/) ·
  [Decode video](/docs/guides/decode-video/) · [Troubleshooting](/docs/guides/troubleshooting/)
