---
title: "Browser & environment support"
description: "Where wasmpeg runs — the minimum browser versions, what WebGPU adds, Node support, and the feature-by-feature requirements for each runtime."
weight: 70
---
wasmpeg needs WebAssembly with **fixed-width SIMD (SIMD128)**. That's the only hard
requirement; everything else (WebGPU, threads) is optional and degrades gracefully.

## The one hard requirement

SIMD128 is what makes `libswscale` fast enough to be worth running in the browser, so the
default package compiles for it unconditionally. There's no scalar fallback build. If the
runtime can't instantiate SIMD WASM, `load()` rejects — before any decode — and that's your
signal the environment is unsupported.

Everything past SIMD is opt-in and falls back on its own:

- **WebGPU** — used for GPU scaling when present, CPU scaling when not.
- **WebGPU build vs CPU build** — the loader picks one at `load()`; the API is identical.
- **Threads / `SharedArrayBuffer`** — not used at all, so no headers are needed.

## Browsers

| Browser | Minimum | Notes |
|---------|---------|-------|
| Chrome / Edge | 91+ | SIMD shipped in 91 (May 2021). |
| Firefox | 89+ | SIMD shipped in 89. |
| Safari | 16.4+ | SIMD shipped in 16.4 (March 2023). |
| Chrome Android | 91+ | Same engine as desktop Chrome. |
| Safari iOS | 16.4+ | Same engine as desktop Safari. |

If a browser lacks SIMD, the module fails to instantiate at `load()`. There is no non-SIMD
fallback build in the default package. Safari is the version that matters in practice — SIMD
landed late there (16.4, March 2023), so it sets the real-world floor for most audiences.

## What WebGPU adds

WebGPU is **optional**. When present, the loader can use the WebGPU build, which runs the
`scale_webgpu` filter on the GPU; otherwise scaling runs on the CPU via `libswscale`. The
API is identical either way.

| Capability | Requirement |
|------------|-------------|
| Decode, audio, probe, encode | SIMD128 only |
| GPU-accelerated scaling | A WebGPU-capable browser (Chrome 113+, recent Safari/Firefox) |

The selection happens automatically: if `navigator.gpu` exists, the loader fetches the
WebGPU build; otherwise it fetches the CPU build. Nothing in your code changes between them,
and `scale()` emits the right filter for whichever build loaded. You can check what's active
at runtime with `gpu.hasWebGPU()`.

WebGPU support is experimental — see [WebGPU](/docs/webgpu/). For production, the CPU path is the
supported default.

## Node.js

| Runtime | Minimum | Notes |
|---------|---------|-------|
| Node.js | 18+ | Uses built-in `fetch` and `fs`; no native addons. |

Node has no WebGPU adapter, so the CPU build is always used. The `.wasm` is read from disk
rather than fetched. The full high-level API works identically — handy for tests,
thumbnail generation, and server-side pipelines.

The browser-only inputs are the one gap: `HTMLVideoElement`, `HTMLCanvasElement`, and
`ImageData` don't exist in Node, so feed it bytes (`Uint8Array`/`ArrayBuffer`) or a file you
read off disk. Everything else — decode, audio, probe, scale, image encode — behaves exactly
as it does in the browser.

{{< aside type="note" title="Deno & Bun" >}}
Bun (which targets Node compatibility) and Deno generally work because the module is plain
ESM + WASM with no native dependencies, but they aren't part of the tested matrix yet.
{{< /aside >}}

## No cross-origin isolation needed

Unlike multi-threaded WASM builds, wasmpeg does **not** require:

- `SharedArrayBuffer`
- `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers
- A dedicated Web Worker

It runs on the main thread (or any worker you choose to put it in) on an ordinary static
host. This is the main practical difference from `@ffmpeg/ffmpeg`'s multi-threaded build.

In concrete terms: you can host wasmpeg on a plain CDN or static bucket, embed it in a
cross-origin iframe, and run it alongside third-party scripts that COEP would otherwise
break. Because it stays single-threaded, decode runs on whatever thread you call it from —
put it in a Web Worker yourself if you want to keep the main thread free, but nothing forces
you to.

## Feature matrix

| Feature | Browser | Node |
|---------|---------|------|
| Decode video → RGBA | Yes | Yes |
| Decode audio → PCM | Yes | Yes |
| Probe metadata | Yes | Yes |
| Scale / filter a frame | Yes | Yes |
| Encode image (thumbnail) | Yes | Yes |
| GPU scaling | WebGPU only | No |
| Canvas / video element input | Yes | No |

## Checking support at runtime

The most reliable capability check is to try loading and catch the failure:

```js

try {
    await wasmpeg.load();
    // ready — SIMD is available and the WASM instantiated
} catch (err) {
    // unsupported runtime, or the .wasm failed to load
}
```

A SIMD-related failure throws at `load()`, before any decode runs, so this also catches old
browsers. To branch specifically on GPU scaling, check `gpu.hasWebGPU()` after loading — but
you rarely need to, since the CPU path produces identical output.

{{< aside type="tip" >}}
Not sure a runtime is supported? Call `await wasmpeg.load()` in a try/catch — if it
resolves, you're good. A SIMD-related failure throws at this point, before any decode.
{{< /aside >}}
