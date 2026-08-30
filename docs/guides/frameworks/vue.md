---
title: "Vue"
description: "Use wasmpeg in a Vue 3 app — decode a frame to a canvas in a single-file component, share the loaded module with a composable, probe metadata, and offload to a worker."
weight: 30
---
wasmpeg is framework-agnostic, so in Vue you call the same API from `onMounted`, a watcher,
or a composable. On a Vite-based Vue app the WASM is served automatically; on other bundlers
you may need to copy it into `public/` (covered at the end).

## Single-file component

{{< steps >}}
{{% step %}}
Install:

   ```sh
   npm install wasmpeg
   ```
{{% /step %}}
{{% step %}}
Decode a frame in a component. Loading the module and opening the decoder both happen in
   `onMounted` so they only run in the browser, never during SSR:

   ```vue
   <script setup>
   import { ref, onMounted, onBeforeUnmount } from 'vue';
   import wasmpeg from 'wasmpeg';

   const props = defineProps({ file: { type: Object, required: true } });
   const canvas = ref(null);
   let dec;

   onMounted(async () => {
       await wasmpeg.load();
       dec = await wasmpeg.decode(props.file);
       const frame = dec.nextFrame();
       if (!frame) return;
       canvas.value.width = dec.width;
       canvas.value.height = dec.height;
       canvas.value
           .getContext('2d')
           .putImageData(new ImageData(frame, dec.width, dec.height), 0, 0);
   });

   onBeforeUnmount(() => dec?.close());
   </script>

   <template>
       <canvas ref="canvas" />
   </template>
   ```
{{% /step %}}
{{< /steps >}}

`decode()` takes the `File` or `Blob` straight from an input or drop event. Each
`nextFrame()` returns RGBA8 pixels as a `Uint8ClampedArray` sized width × height × 4, or
`null` once the stream ends.

{{< aside type="caution" >}}
Close the decoder in `onBeforeUnmount`. Every open decoder holds a session and native
buffers; if the component unmounts mid-decode and you skip `close()`, those resources leak.
{{< /aside >}}

## React to a changing file

If the `file` prop can change while the component is mounted, watch it and re-open the
decoder, closing the previous one first:

```vue
<script setup>

const props = defineProps({ file: { type: Object, required: true } });
const canvas = ref(null);
let dec;

watch(
    () => props.file,
    async (file) => {
        await wasmpeg.load();
        dec?.close();
        dec = await wasmpeg.decode(file);
        const frame = dec.nextFrame();
        if (!frame) return;
        canvas.value.width = dec.width;
        canvas.value.height = dec.height;
        canvas.value
            .getContext('2d')
            .putImageData(new ImageData(frame, dec.width, dec.height), 0, 0);
    },
    { immediate: true },
);

onBeforeUnmount(() => dec?.close());
</script>

<template>
    <canvas ref="canvas" />
</template>
```

## Reusable composable

Wrap loading in a composable so the module loads once and is shared across components. The
`??=` keeps the call idempotent — the first caller starts the load, everyone else awaits the
same promise:

```js
// useWasmpeg.js

let ready;
export function useWasmpeg() {
    ready ??= wasmpeg.load();
    return { wasmpeg, ready };
}
```

```vue
<script setup>

const { wasmpeg, ready } = useWasmpeg();

async function inspect(file) {
    await ready;
    const info = await wasmpeg.probe(file);
    console.log(info.format, info.duration, info.video.width, info.video.height);
}
</script>
```

`probe()` returns container format, duration in seconds (or `null` when unknown), bitrate,
the stream list, and video/audio details — without decoding any frames, so it's cheap enough
to run on every selected file.

## Offload decoding to a Worker

Decoding blocks the thread it runs on. For long clips, move it into a Web Worker so the UI
keeps painting. The API is the same inside a worker:

```js
// decode.worker.js

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

On Vite, instantiate it with `new Worker(new URL('./decode.worker.js', import.meta.url), { type: 'module' })`.
Transferring `frame.buffer` moves the pixels to the main thread without a copy.

## If the WASM 404s

On a non-Vite bundler, or if `cpu.wasm` shows up as a 404, copy the binaries into `public/`
and pass an explicit path:

```sh
cp node_modules/wasmpeg/dist/cpu.* public/wasmpeg/
```

```js
await wasmpeg.load({ wasmPath: '/wasmpeg/cpu.js' });   // cpu.wasm sits beside it
```

{{< aside type="tip" >}}
For frame-by-frame playback, drive `nextFrame()` from `requestAnimationFrame` rather than a
tight loop, and always `close()` the decoder in `onBeforeUnmount`.
{{< /aside >}}

## Related

- [Decode video](/docs/guides/decode-video/) · [Probe metadata](/docs/guides/probe/) ·
  [Quick start](/docs/start/quick-start/) · [Troubleshooting](/docs/guides/troubleshooting/)
