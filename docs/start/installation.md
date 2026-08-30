---
title: "Installation"
description: "Install wasmpeg and get a first decode running — npm or CDN, in a bundler, a framework, or Node, with no build step and no special server headers."
weight: 20
---
wasmpeg ships as an ES module with the WASM binaries alongside it. **No build step, no
SharedArrayBuffer, no COOP/COEP headers, and no worker setup** are required.

## Quick install

{{< steps >}}
{{% step %}}
**Install the package.**

   {{< tabs >}}
{{< tab label="npm" group="tabgroup-0" first="true" >}}
<pre><code>npm install wasmpeg</code></pre>
{{< /tab >}}
{{< tab label="pnpm" group="tabgroup-0" >}}
<pre><code>pnpm add wasmpeg</code></pre>
{{< /tab >}}
{{< tab label="yarn" group="tabgroup-0" >}}
<pre><code>yarn add wasmpeg</code></pre>
{{< /tab >}}
{{< tab label="bun" group="tabgroup-0" >}}
<pre><code>bun add wasmpeg</code></pre>
{{< /tab >}}
{{< /tabs >}}

   Use `wasmpeg-full` instead if you need H.264/H.265 **encode** (GPL) — see
   [which package](#which-package).
{{% /step %}}
{{% step %}}
**Import it and load the module once.**

   ```js
   import wasmpeg from 'wasmpeg';

   await wasmpeg.load();
   ```

   `load()` fetches and initializes the WASM. It's safe to call again — later calls resolve
   immediately.
{{% /step %}}
{{% step %}}
**Decode something.**

   ```js
   const info = await wasmpeg.probe(file);   // File / Blob / URL / Uint8Array
   const dec = await wasmpeg.decode(file);
   const frame = dec.nextFrame();            // Uint8ClampedArray of RGBA8
   dec.close();
   ```
{{% /step %}}
{{< /steps >}}

That's the whole setup. From here, the [quick start](/docs/start/quick-start/) covers decode,
scale, probe, audio, and thumbnails.

## Which package

{{< cardgrid >}}
{{< cardgrid >}}
{{< linkcard title="wasmpeg (LGPL)" href="#quick-install" description="LGPL-2.1-or-later. Safe for commercial and closed-source. Includes H.264/H.265 decode. What most projects want." >}}
{{< linkcard title="wasmpeg-full (GPL)" href="#quick-install" description="GPL-2.0-or-later. Adds H.264/H.265 encode via libx264/libx265. Requires GPL compliance to embed." >}}
{{< /cardgrid >}}
{{< /cardgrid >}}

The import surface is identical between them; only the codec set differs. Code written
against `wasmpeg` runs unchanged against `wasmpeg-full` — you only swap the package when you
specifically need x264/x265 encode and can meet the GPL terms.

| | `wasmpeg` | `wasmpeg-full` |
|---|-----------|----------------|
| License | LGPL-2.1-or-later | GPL-2.0-or-later |
| H.264 / H.265 decode | Yes | Yes |
| H.264 / H.265 encode | No | Yes (libx264 / libx265) |
| Use for closed-source | Yes | Only under GPL terms |
| Import surface | Identical | Identical |

## Loading the module

`load()` does three things: detects the environment, picks a build, and instantiates the
WASM. You await it once before any other call.

```js

await wasmpeg.load();
```

It's idempotent — call it from every module that needs wasmpeg if that's simpler than
threading a "ready" flag around; only the first call does real work. The same is true of
the `gpu` namespace and the `FFmpeg` class, which share the one module instance.

If a browser can't instantiate the module (no WebAssembly SIMD support), the failure surfaces
as a rejected `load()` promise, before any decode runs. Wrapping the first `load()` in a
`try/catch` is the simplest capability check — see [Browser support](/docs/start/support/).

## Serving the WASM

The package contains `dist/cpu.js` and `dist/cpu.wasm` (plus `webgpu.js` / `webgpu.wasm` for
the GPU build). At runtime, the `.js` loads its `.wasm` from **the same directory**. How that
directory is served depends on your setup:

{{< tabs >}}
{{< tab label="Bundler" group="tabgroup-1" first="true" >}}
Most bundlers (Vite, webpack 5, Rollup, esbuild) handle the co-located `.wasm`
automatically when you `import wasmpeg from 'wasmpeg'`. If your bundler doesn't emit
the `.wasm` next to the JS, copy `node_modules/wasmpeg/dist/` into your static
directory and point the loader at it:

```js
await wasmpeg.load({ wasmPath: '/wasmpeg/cpu.js' });   // cpu.wasm sits beside it
```

See the [framework guides](/docs/guides/frameworks/vite/) for per-tool specifics.
{{< /tab >}}
{{< tab label="CDN / no bundler" group="tabgroup-1" >}}
```html
<script type="module">
    import wasmpeg from 'https://esm.sh/wasmpeg';
    await wasmpeg.load();
    const info = await wasmpeg.probe(file);
</script>
```

Any ESM CDN that serves the package and its `dist/*.wasm` works (esm.sh, jsDelivr,
unpkg). The `.wasm` is fetched relative to the JS module.
{{< /tab >}}
{{< tab label="Node ≥ 18" group="tabgroup-1" >}}
```js
import wasmpeg from 'wasmpeg';
import { readFile } from 'node:fs/promises';

await wasmpeg.load();
const bytes = await readFile('clip.mp4');
const info = await wasmpeg.probe(bytes);
```

Node has no WebGPU adapter, so the CPU build is used automatically, and the `.wasm`
is read from disk rather than fetched.
{{< /tab >}}
{{< /tabs >}}

### The `wasmPath` option

`load()` accepts `{ wasmPath }` — a URL to the loader `.js`, with the matching `.wasm`
expected in the same directory. Reach for it when your bundler fingerprints or relocates
assets and the default same-directory resolution can't find the binary. Point it at the `.js`
file; the loader derives the `.wasm` name from it.

```js
// Serving the dist folder yourself at /vendor/wasmpeg/
await wasmpeg.load({ wasmPath: '/vendor/wasmpeg/cpu.js' });
```

If you've copied the WebGPU build instead, point at `webgpu.js`. When `wasmPath` is omitted,
the loader chooses `webgpu.js` where `navigator.gpu` exists and `cpu.js` otherwise.

{{< aside type="tip" title="The one thing that goes wrong" >}}
99% of setup issues are the browser failing to fetch `cpu.wasm` (a 404 in the network tab).
The fix is always the same: make sure the `.wasm` is served next to the `.js`, or pass an
explicit `wasmPath`. See [Troubleshooting](/docs/guides/troubleshooting/#the-wasm-fails-to-load).
{{< /aside >}}

## Requirements

- **Browsers** — any with WebAssembly + SIMD128: Chrome 91+, Firefox 89+, Safari 16.4+.
  WebGPU scaling additionally needs a WebGPU-capable browser; everything else falls back to
  CPU. Full matrix in [Browser support](/docs/start/support/).
- **Node** — ≥ 18 (uses built-in `fetch`/`fs`; no native addons).

No headers, no cross-origin isolation, and no Web Worker are required. wasmpeg runs on an
ordinary static host and on the main thread (or any worker you choose to put it in).

## Verify the install

A quick end-to-end check that the package resolved and the WASM loads:

```js

await wasmpeg.load();
console.log('wasmpeg loaded');   // if this prints, the module instantiated
```

If `load()` rejects in the browser, it's almost always one of two things: the runtime lacks
SIMD (an old browser), or the `.wasm` 404'd. The network tab tells you which.

## Next steps

{{< cardgrid >}}
{{< cardgrid >}}
{{< linkcard title="Framework guides" href="/docs/guides/frameworks/vite/" description="Vite, Next.js, Vue, Svelte, Node." >}}
{{< linkcard title="Quick start" href="/docs/start/quick-start/" description="Decode, scale, probe, encode." >}}
{{< linkcard title="How it works" href="/docs/start/how-it-works/" description="The architecture and mental model." >}}
{{< linkcard title="Troubleshooting" href="/docs/guides/troubleshooting/" description="When something doesn't load." >}}
{{< /cardgrid >}}
{{< /cardgrid >}}
