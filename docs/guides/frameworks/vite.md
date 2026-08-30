---
title: "Vite"
description: "Use wasmpeg in a Vite project (including React, Vue, or Svelte on Vite) — install, serve the WASM, decode in a component, and move work into a worker."
weight: 10
---
Vite is the smoothest setup. It serves the package's co-located `.wasm` during dev and
emits it on build with no extra config, because the loader resolves the binary relative to
its own module URL and Vite understands that pattern. Everything here applies to any Vite
app — vanilla, React, Vue, or Svelte.

## Install

```sh
npm install @wasmpeg/core
```

wasmpeg is ESM-only, which is exactly what Vite expects, so there's nothing to configure in
`vite.config.js` for the common case.

## Load once, then decode

You only need to call `wasmpeg.load()` a single time per page. It's idempotent — calling it
again returns immediately — but loading and compiling the WASM still costs something, so do
it once and share the loaded module.

{{< tabs >}}
{{< tab label="React" group="tabgroup-0" first="true" >}}
```jsx

export function Thumbnail({ file }) {
    const canvasRef = useRef(null);

    useEffect(() => {
        let dec;
        let cancelled = false;

        (async () => {
            await wasmpeg.load();
            if (cancelled) return;
            dec = await wasmpeg.decode(file);
            const frame = dec.nextFrame();
            if (!frame) return;
            const canvas = canvasRef.current;
            canvas.width = dec.width;
            canvas.height = dec.height;
            canvas
                .getContext('2d')
                .putImageData(new ImageData(frame, dec.width, dec.height), 0, 0);
        })();

        return () => {
            cancelled = true;
            dec?.close();
        };
    }, [file]);

    return <canvas ref={canvasRef} />;
}
```

The `cancelled` flag matters in React's Strict Mode and on fast prop changes: the effect can
run, then re-run, before the first async chain finishes. Without the guard you'd write a
frame from a stale decoder onto the canvas.
{{< /tab >}}
{{< tab label="Vanilla" group="tabgroup-0" >}}
```js

const input = document.querySelector('#file');
const canvas = document.querySelector('#preview');

input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    await wasmpeg.load();
    const dec = await wasmpeg.decode(file);
    try {
        const frame = dec.nextFrame();
        canvas.width = dec.width;
        canvas.height = dec.height;
        canvas
            .getContext('2d')
            .putImageData(new ImageData(frame, dec.width, dec.height), 0, 0);
    } finally {
        dec.close();
    }
});
```
{{< /tab >}}
{{< /tabs >}}

In the browser, `decode()` accepts a `File` or `Blob` straight from an `<input type="file">`
or a drag-and-drop event — no need to read it into an `ArrayBuffer` yourself. Each call to
`nextFrame()` returns the next frame as RGBA8 pixels (`Uint8ClampedArray`, width × height × 4
bytes), or `null` at the end of the stream.

{{< aside type="caution" >}}
Always `close()` the decoder when you're done with it. Each open decoder holds a session and
native buffers; leaking them will eventually exhaust the available slots. Close it in your
cleanup function, or in a `finally` block for one-shot work.
{{< /aside >}}

## Probe before you decode

If you only need dimensions, duration, or stream info — say, to decide whether a file is even
a video before spending time decoding — use `probe()`:

```js
await wasmpeg.load();
const info = await wasmpeg.probe(file);
console.log(info.format, info.duration, info.video.width, info.video.height);
console.log('streams:', info.streams.map((s) => s.type).join(', '));
```

## If the WASM 404s

The default loader fetches the binary from a URL relative to the package. If your build
output doesn't co-locate it — or you've hit a 404 in the network tab for `cpu.wasm` — copy
the binaries into `public/` and point the loader at the `.js`:

```sh
cp node_modules/wasmpeg/dist/cpu.* public/wasmpeg/
```

```js
await wasmpeg.load({ wasmPath: '/wasmpeg/cpu.js' });   // cpu.wasm must sit beside it
```

`public/` is served at the site root by Vite, so this works in dev and in the production
build without bundler involvement. Keep both `cpu.js` and `cpu.wasm` together: the `.js`
resolves its `.wasm` from the same directory.

## Run decoding in a Web Worker

Decoding is CPU-bound and synchronous inside each `nextFrame()` call, so a long clip will
stutter the main thread. The whole API works unchanged inside a Web Worker — Vite has
first-class worker support, so you can import one with the `?worker` suffix.

```js
// decode.worker.js

let ready;

self.onmessage = async (e) => {
    ready ??= wasmpeg.load();
    await ready;

    const dec = await wasmpeg.decode(e.data.file);
    try {
        for (let frame; (frame = dec.nextFrame()); ) {
            // Transfer the buffer so it isn't copied across the boundary.
            self.postMessage(
                { width: dec.width, height: dec.height, frame },
                [frame.buffer],
            );
        }
    } finally {
        dec.close();
        self.postMessage({ done: true });
    }
};
```

```js
// main.js

const worker = new DecodeWorker();
worker.postMessage({ file });
worker.onmessage = (e) => {
    if (e.data.done) return;
    const { width, height, frame } = e.data;
    ctx.putImageData(new ImageData(frame, width, height), 0, 0);
};
```

Transferring `frame.buffer` (rather than letting it be structured-cloned) hands the pixel
memory to the main thread with no copy. Don't read `frame` in the worker after transferring
it — the buffer is detached on this side once it's posted.

{{< aside type="tip" >}}
For frame-by-frame playback, drive `nextFrame()` from `requestAnimationFrame` so you decode
roughly one frame per repaint, rather than running a tight loop that races ahead of what the
screen can show.
{{< /aside >}}

## Related

- [Quick start](/docs/start/quick-start/) · [Decode video](/docs/guides/decode-video/) ·
  [Probe metadata](/docs/guides/probe/) · [Troubleshooting](/docs/guides/troubleshooting/)
