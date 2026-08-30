---
title: "WebGPU (experimental)"
description: "How GPU-accelerated scaling works, what's wired up today, and the honest state of WebGPU support."
weight: 60
---
{{< aside type="caution" title="Experimental" >}}
WebGPU support is **scaffolded end-to-end but lightly validated.** The plumbing exists
and compiles, but it relies on a custom FFmpeg WebGPU hardware context, the prebuilt
WebGPU binary isn't part of the default test run, and only one GPU filter is wired up.
Treat it as experimental — the CPU path is the supported default.
{{< /aside >}}

## What it does

On a WebGPU-capable browser, `gpu.load()` loads the WebGPU build, and scale operations
run on the GPU via the `scale_webgpu` filter instead of libswscale. The API is identical
— `wasmpeg.scale()`, `dec.nextFrame(w, h)`, and `gpu.scale()` all transparently pick the
GPU path when it's available and fall back to CPU otherwise.

```js

await gpu.load();
gpu.hasWebGPU();   // true only on the WebGPU build with an adapter present
```

### How the path is chosen

There's no separate GPU API to learn. The same calls run on either backend, and the
decision is made per operation:

- `hasWebGPU()` returns `true` only when you loaded the WebGPU build *and* the browser
  handed back a GPU adapter. On the CPU build, or in Node, it's always `false`.
- When it's `true`, scale operations route through `scale_webgpu`. When it's `false`, they
  fall back to libswscale on the CPU.
- Because the fallback is automatic, code written against `gpu.scale()` keeps working with
  no branches when WebGPU isn't available — it just runs on the CPU.

## How it's built

The WebGPU target differs from the CPU build in three ways (all handled by
`TARGET=webgpu bash scripts/build.sh`):

- `--use-port=emdawnwebgpu` in the configure cflags and the `emcc` link
- `-s ASYNCIFY` in the link (GPU calls are async)
- `-DCONFIG_WEBGPU` to compile `pipeline_run_rgba_gpu` and `bench_scale_webgpu`

It produces `dist/webgpu.js` + `dist/webgpu.wasm`, which the loaders select when
`navigator.gpu` exists. The configurator also appends `--enable-webgpu` and
`--enable-filter=scale_webgpu` to the FFmpeg configure flags for this target only.
This is the same binary shipped in [`@wasmpeg/core`](/docs/start/installation/#which-package)
on npm — you don't need to build it yourself to try it.

One consequence of `ASYNCIFY`: the WebGPU module's calls are async under the hood, which
adds some code size and call overhead the CPU build doesn't pay. That's part of why the CPU
build stays the default even on machines that have a GPU.

## Current limitations

- **One filter.** Only `scale_webgpu` is GPU-accelerated. Every other filter runs on the
  CPU.
- **Custom FFmpeg.** The build pulls in `libavutil/hwcontext_webgpu.h`, which is **not**
  in mainline FFmpeg — the vendored tree carries a WebGPU hardware-context patch.
- **Not in the default test run.** Node has no WebGPU adapter, so the GPU path is skipped
  in `tests/test.mjs` and the FATE harnesses default to the CPU build. Validating it means
  building `webgpu.wasm` and exercising it in a real browser.

## Benchmarking

`tests/bench.html` runs the GPU and CPU scale paths side by side in a browser. From code:

```js
gpu.benchGpu(1920, 1080, 1280, 720, 50);  // ms/frame on the GPU build
gpu.benchCpu(1920, 1080, 1280, 720, 50);  // ms/frame on the CPU
```

`benchGpu` returns `-1` on the CPU build.

## Should you use it?

For production, prefer the CPU build — it's SIMD-accelerated, fully tested, and loads
without ASYNCIFY overhead. Reach for the WebGPU build when you're scaling large frames in
a tight loop in a browser you control and can verify the output yourself.
