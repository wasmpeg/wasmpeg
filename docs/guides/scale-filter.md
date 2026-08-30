---
title: "Scale & filter a frame"
description: "Run any FFmpeg filtergraph on a single frame and get RGBA8 pixels back — GPU-accelerated when WebGPU is available."
weight: 30
---
`wasmpeg.scale()` decodes the first frame of an input (or takes raw pixels directly), runs
an FFmpeg filtergraph over it, and returns a `Uint8ClampedArray` of RGBA8 pixels at the
output size. On a WebGPU-capable browser the scale runs on the GPU; otherwise it falls
back to libswscale on the CPU. Same call, same result — only the path underneath changes.

## Synopsis

```js
const rgba = await wasmpeg.scale(input, dstW, dstH, filter?);
// → Uint8ClampedArray, length === dstW * dstH * 4
```

## Description

Despite the name, `scale()` is a single-frame filter pass, not just a resizer. The fourth
argument is a full FFmpeg filtergraph, so you can crop, flip, blur, recolor, or chain
several filters in one call. When you omit it, the default graph is `scale=dstW:dstH` — a
plain resize.

The input can be encoded media or raw pixels. For a `File`, `Blob`, URL, `Uint8Array`, or
`ArrayBuffer`, `scale()` decodes the first frame and filters that. For a `canvas`,
`HTMLVideoElement`, or `ImageData`, it skips decoding and filters the pixels directly.

One detail drives how you write filtergraphs: the **output size is read from an integer
`scale=` in the graph**, not from the `dstW` / `dstH` arguments. When you pass a custom
filter, include a `scale=` that matches your intended output, and pass the same numbers as
`dstW` / `dstH` so the returned array is sized correctly.

## Parameters

`scale(input, dstW, dstH, filter?)`

- **`input`** — encoded media (`File`, `Blob`, URL, `Uint8Array`, `ArrayBuffer`) or raw
  pixels (`canvas`, `HTMLVideoElement`, `ImageData`).
- **`dstW`, `dstH`** — output width and height in pixels. With the default graph these set
  the resize target. With a custom graph they should match the `scale=` you put in it.
- **`filter`** — optional filtergraph string. Defaults to `scale=dstW:dstH`.

Returns a `Uint8ClampedArray` of RGBA8 pixels, `dstW * dstH * 4` bytes.

## Scale to a size

{{< steps >}}
{{% step %}}
Load the module.

   ```js
   import wasmpeg from '@wasmpeg/core';
   await wasmpeg.load();
   ```
{{% /step %}}
{{% step %}}
Scale to a target. The default graph is a plain resize.

   ```js
   const rgba = await wasmpeg.scale(file, 1280, 720);   // RGBA8 at 1280×720
   ```
{{% /step %}}
{{% step %}}
Drop the result onto a canvas.

   ```js
   const ctx = canvas.getContext('2d');
   ctx.putImageData(new ImageData(rgba, 1280, 720), 0, 0);
   ```
{{% /step %}}
{{< /steps >}}

## Arbitrary filtergraphs

Pass a full filtergraph as the fourth argument. Because the output size comes from the
`scale=` in the graph, include one that matches your target — and chain whatever else you
need around it:

```js
const flipped  = await wasmpeg.scale(file, 1280, 720, 'scale=1280:720,hflip');
const cropped  = await wasmpeg.scale(file, 640, 480, 'crop=640:480:0:0,scale=640:480');
const grayed   = await wasmpeg.scale(file, 1280, 720, 'scale=1280:720,format=gray,format=rgba');
```

Filters run left to right. In the gray example, `format=gray` drops chroma and
`format=rgba` packs the result back into the RGBA8 the function returns. Output always
comes back as RGBA8 regardless of any intermediate pixel format in the graph.

{{< aside type="caution" title="Include a scale= with your output size" >}}
The output dimensions are parsed from an integer `scale=W:H` (or `scale=w=W:h=H`) in the
graph. A graph with no `scale=`, or one that uses expressions like `scale=iw/2:ih/2`,
leaves wasmpeg unable to size the output buffer — it falls back to the source dimensions,
which may not be what your filters produced. Use literal integers and match them to
`dstW` / `dstH`.
{{< /aside >}}

### Filters in the default build

Any filter compiled into the build works. The default build includes the common geometry
and color filters — `crop`, `overlay`, `hflip` / `vflip`, `transpose`, `rotate`, `pad`,
`eq`, `hue`, `curves`, `unsharp`, `boxblur`, `gblur`, and more. The
[configuration reference](/docs/build/configuration/) lists the full set, and the
[filters page](/docs/formats/filters/) documents what each one does.

## Filter raw pixels

`scale()` accepts a `canvas`, `HTMLVideoElement`, or `ImageData` directly. There's no
decode step — it filters the pixels you hand it:

```js
const out = await wasmpeg.scale(canvas, 512, 512, 'scale=512:512,gblur=sigma=2');
```

This is the quick path for processing something already on screen: blur a
canvas, desaturate a frame grabbed from a `<video>`, or downscale an `ImageData` you built
by hand.
A video element must be loaded (have real `videoWidth` / `videoHeight`) before you pass
it, or the input normalizer throws.

## GPU vs CPU

{{< aside type="note" title="How the path is chosen" >}}
The filter that does the GPU work is `scale_webgpu`. When you call `scale()` with the
default graph, wasmpeg picks `scale_webgpu=…` on the WebGPU build and plain `scale=…` on
the CPU build automatically — you don't choose. To compare the two paths directly, use
[`gpu.benchGpu` / `gpu.benchCpu`](/docs/reference/gpu/).
{{< /aside >}}

The GPU path accelerates the scale itself. Other filters in your graph run on the CPU, so
a heavy graph spends most of its time there regardless of build. The win is largest for
plain resizes of large frames.

## One frame, not a stream

`scale()` operates on a **single frame** — the first one for a media file. There's no loop
inside it and no way to make it walk a stream. To process every frame, open a
[decoder](/docs/guides/decode-video/) and call `nextFrame(w, h)` in a loop, which also scales on
decode, or run frames through [`encode()`](/docs/guides/encode/) to get encoded image output.

## See also

- [Decode video frames](/docs/guides/decode-video/) — process every frame, not just the first.
- [Encode & thumbnails](/docs/guides/encode/) — turn a filtered frame into a JPEG or PNG.
- [GPU reference](/docs/reference/gpu/) — the lower-level `gpu.scale` and the benchmarks.
