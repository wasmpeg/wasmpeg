---
title: "Filter reference"
description: "The FFmpeg filters compiled into the default build, with examples, key parameters, and a clear split between the ones that work in wasmpeg's single-frame pipeline and the ones that don't."
weight: 20
---
These are the filters compiled into the default LGPL build (the `filters` list in the
`lgpl` preset). They are passed as a filtergraph string to
[`wasmpeg.scale(input, w, h, graph)`](/docs/reference/high-level/#scale)
or [`wasmpeg.run(input, ['-vf', graph])`](/docs/reference/exec-commands/#video-filtering--vf).

Each filter below lists the parameters you'll actually reach for — not the full FFmpeg
option set. For every option, every default, and every edge case, the
[FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html) is the source of
truth; each heading links to its exact section there. What you won't find on that page is
which of these filters actually *do* anything when driven through wasmpeg's pipeline —
that's what this page is for.

{{< aside type="caution" title="Single frame, single input" >}}
wasmpeg's filter pipeline runs **one frame** through **one** buffer source. That shapes
what's usable: per-frame video filters work; filters that need a stream of frames
(temporal) or a second input do not, even though they're compiled in. Each section below
says which is which. Audio filters are compiled but are not applied by the dispatcher —
see [Audio filters](#audio-filters).
{{< /aside >}}

When a filter changes the frame's dimensions, end the graph with an explicit integer
`scale=W:H` so the returned buffer is sized correctly — see
[output sizing](/docs/reference/exec-commands/#output-sizing).

## At a glance

Every filter below is compiled into the build. What varies is whether the single-frame
pipeline can actually drive it:

| Group | Filters | Works in the pipeline? |
|-------|---------|------------------------|
| Geometry & transform | `scale` `crop` `pad` `transpose` `rotate` `hflip` `vflip` | Yes — per-frame |
| Pixel format | `format` `colorspace` | Yes — per-frame |
| Color & tone | `eq` `hue` `curves` `colorbalance` `colorchannelmixer` | Yes — per-frame |
| Blur / sharpen / noise | `boxblur` `gblur` `unsharp` `noise` | Yes — per-frame |
| GPU | `scale_webgpu` | Yes — WebGPU build only |
| Multi-input | `overlay` `hstack` `vstack` `amerge` `amix` `concat` `split` | No — second input has nothing to feed it |
| Temporal | `fps` `trim` `setpts` `yadif` `bwdif` `deinterlace` | No — need a stream of frames |
| Audio | `aresample` `volume` `atrim` `asetpts` `aecho` `highpass` `lowpass` `equalizer` `anull` | Compiled, but not applied by the dispatcher |
| Passthrough | `null` `anull` | Yes — explicit no-ops |

The "Yes" rows are documented with examples in the sections that follow; the "No" rows are
explained under [Multi-input](#multi-input-filters), [Temporal](#temporal-filters), and
[Audio](#audio-filters).

## Geometry and transform

### [scale](https://ffmpeg.org/ffmpeg-filters.html#scale-1)

Resize to a target size. The output dimensions of a graph are read from this filter.

**Parameters:** `w`, `h` (size, `-1` keeps aspect) · `flags` (scaling algorithm —
`bilinear` default, `lanczos`/`spline` for quality) · `force_original_aspect_ratio`

```js
await wasmpeg.scale(file, 1280, 720);                 // implicit scale=1280:720
await wasmpeg.run(file, ['-vf', 'scale=1280:720']);
await wasmpeg.run(file, ['-vf', 'scale=1280:720:flags=lanczos']);   // sharper downscale
```

### [crop](https://ffmpeg.org/ffmpeg-filters.html#crop)

Cut a `w×h` region at offset `x,y`. Follow with `scale` to the cropped size.

**Parameters:** `w`, `h`, `x`, `y` — `x`/`y` default to centered if omitted.

```js
await wasmpeg.scale(file, 640, 480, 'crop=640:480:0:0,scale=640:480');
await wasmpeg.scale(file, 640, 480, 'crop=640:480,scale=640:480');   // centered crop
```

### [pad](https://ffmpeg.org/ffmpeg-filters.html#pad-1)

Add borders to reach a larger canvas, optionally with a background color.

**Parameters:** `width`, `height`, `x`, `y` (offset of the original frame within the new
canvas), `color` (CSS-style name or `0xRRGGBB`).

```js
await wasmpeg.scale(file, 1280, 720, 'pad=1280:720:80:0:black,scale=1280:720');
```

### [transpose](https://ffmpeg.org/ffmpeg-filters.html#transpose-1)

Rotate by 90° and swap width/height. Scale to the swapped dimensions.

**Parameters:** `dir` — `0` (90° CCW + vflip), `1` (90° CW), `2` (90° CCW), `3` (90° CW +
vflip).

```js
// transpose=1 → 90° clockwise
await wasmpeg.scale(file, 720, 1280, 'transpose=1,scale=720:1280');
```

### [rotate](https://ffmpeg.org/ffmpeg-filters.html#rotate)

Rotate by an arbitrary angle in radians (output keeps the source size unless `ow`/`oh`
are given).

**Parameters:** `angle` (radians, or an expression like `PI/6`) · `ow`, `oh` (output size)
· `fillcolor` (area exposed outside the source frame).

```js
await wasmpeg.scale(file, 1280, 720, 'scale=1280:720,rotate=PI/6');
await wasmpeg.run(file, ['-vf', 'rotate=PI/6:fillcolor=black']);
```

### [hflip](https://ffmpeg.org/ffmpeg-filters.html#hflip) / [vflip](https://ffmpeg.org/ffmpeg-filters.html#vflip)

Mirror horizontally or vertically. Dimensions are unchanged, so no trailing `scale` is
required. Neither takes parameters.

```js
await wasmpeg.run(file, ['-vf', 'hflip']);
await wasmpeg.run(file, ['-vf', 'vflip']);
```

## Pixel format

### [format](https://ffmpeg.org/ffmpeg-filters.html#format-1)

Force an intermediate pixel format. Useful to coerce a processing format; convert back to
`rgba` at the end if needed.

**Parameters:** `pix_fmts` — a `|`-separated list of acceptable formats (e.g. `gray`,
`yuv420p`, `rgba`).

```js
await wasmpeg.scale(file, 1280, 720, 'scale=1280:720,format=gray,format=rgba');
```

### [colorspace](https://ffmpeg.org/ffmpeg-filters.html#colorspace)

Convert between colorspaces (BT.601/709/2020, range, primaries).

**Parameters:** `all` (set every colorspace property from one preset) · `space`,
`range`, `primaries`, `trc` (set individually) · `iall`/`ispace`/etc. (declare the input's
properties when the source doesn't signal them).

```js
await wasmpeg.scale(file, 1280, 720, 'scale=1280:720,colorspace=bt709:iall=bt601-6-625');
```

## Color and tone

### [eq](https://ffmpeg.org/ffmpeg-filters.html#eq)

Adjust brightness, contrast, saturation, and gamma.

**Parameters:** `contrast` (default `1`) · `brightness` (default `0`) · `saturation`
(default `1`) · `gamma` (default `1`) · `gamma_r`/`gamma_g`/`gamma_b` (per-channel gamma).

```js
await wasmpeg.scale(file, 1280, 720, 'scale=1280:720,eq=contrast=1.2:brightness=0.04:saturation=1.1');
```

### [hue](https://ffmpeg.org/ffmpeg-filters.html#hue)

Rotate hue and scale saturation.

**Parameters:** `h` (degrees) · `s` (saturation multiplier) · `b` (brightness).

```js
await wasmpeg.scale(file, 1280, 720, 'scale=1280:720,hue=h=90:s=1.2');
```

### [curves](https://ffmpeg.org/ffmpeg-filters.html#curves-1)

Apply tone curves, including built-in presets.

**Parameters:** `preset` — one of `color_negative`, `cross_process`, `darker`,
`increase_contrast`, `lighter`, `linear_contrast`, `medium_contrast`, `negative`,
`strong_contrast`, `vintage` · or `master`/`red`/`green`/`blue` with explicit control
points (`0/0 0.5/0.58 1/1`).

```js
await wasmpeg.scale(file, 1280, 720, 'scale=1280:720,curves=preset=increase_contrast');
await wasmpeg.run(file, ['-vf', "curves=master='0/0 0.5/0.4 1/1'"]);   // custom curve
```

### [colorbalance](https://ffmpeg.org/ffmpeg-filters.html#colorbalance)

Shift shadows, midtones, and highlights per RGB channel.

**Parameters:** `rs`/`gs`/`bs` (shadows), `rm`/`gm`/`bm` (midtones), `rh`/`gh`/`bh`
(highlights) — each in `[-1, 1]`.

```js
await wasmpeg.scale(file, 1280, 720, 'scale=1280:720,colorbalance=rs=0.1:gm=-0.05');
```

### [colorchannelmixer](https://ffmpeg.org/ffmpeg-filters.html#colorchannelmixer)

Mix channels with a 4×4 matrix — e.g. a sepia tone or a channel swap.

**Parameters:** `rr`/`rg`/`rb`/`ra` … `ar`/`ag`/`ab`/`aa` (16 coefficients, one row per
output channel) — the example below sets only RGB, leaving alpha at its default.

```js
await wasmpeg.scale(file, 1280, 720,
  'scale=1280:720,colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131');
```

## Blur, sharpen, and noise

### [boxblur](https://ffmpeg.org/ffmpeg-filters.html#boxblur)

Fast box blur by radius.

**Parameters:** `luma_radius`/`chroma_radius`/`alpha_radius` (or the short forms
`lr`/`cr`/`ar`) · `luma_power` (repeat count for a smoother falloff).

```js
await wasmpeg.scale(file, 1280, 720, 'scale=1280:720,boxblur=2');
await wasmpeg.run(file, ['-vf', 'boxblur=luma_radius=4:luma_power=2']);
```

### [gblur](https://ffmpeg.org/ffmpeg-filters.html#gblur)

Gaussian blur by sigma — smoother falloff than `boxblur`, more expensive.

**Parameters:** `sigma` (blur strength) · `steps` (quality vs. speed) · `sigmaV`
(vertical sigma, if different from horizontal).

```js
await wasmpeg.scale(file, 1280, 720, 'scale=1280:720,gblur=sigma=3');
```

### [unsharp](https://ffmpeg.org/ffmpeg-filters.html#unsharp-1)

Sharpen (or blur) with an unsharp mask.

**Parameters:** `luma_msize_x`/`luma_msize_y` (matrix size, odd, `3`–`23`) ·
`luma_amount` (positive sharpens, negative blurs) — the positional form below is
`lx:ly:la`.

```js
await wasmpeg.scale(file, 1280, 720, 'scale=1280:720,unsharp=5:5:1.0');
```

### [noise](https://ffmpeg.org/ffmpeg-filters.html#noise)

Add noise — useful for dithering or film-grain effects.

**Parameters:** `alls` (strength, all components) · `allf` (flags — `t` temporal, `u`
uniform, `p` mix with original, `c` per-component).

```js
await wasmpeg.scale(file, 1280, 720, 'scale=1280:720,noise=alls=20:allf=t');
```

## GPU

### scale_webgpu

wasmpeg's own filter — not part of upstream FFmpeg, so there's no FFmpeg doc page for it.
It's the GPU-accelerated scale on the WebGPU build. `wasmpeg.scale()` selects it
automatically when WebGPU is active; pass it explicitly to force it.

**Parameters:** `w`, `h` — same positional size arguments as `scale`.

```js
await wasmpeg.run(file, ['-vf', 'scale_webgpu=1280:720']);
```

See [WebGPU](/docs/webgpu/) for what's actually wired up versus scaffolded.

## Multi-input filters

These are compiled in but **cannot be driven** through wasmpeg today: the pipeline has a
single buffer source, so a filtergraph that needs two inputs has nothing to feed its
second pad.

[`overlay`](https://ffmpeg.org/ffmpeg-filters.html#overlay-1) ·
[`hstack`](https://ffmpeg.org/ffmpeg-filters.html#hstack-1) ·
[`vstack`](https://ffmpeg.org/ffmpeg-filters.html#vstack-1) ·
[`amerge`](https://ffmpeg.org/ffmpeg-filters.html#amerge-1) ·
[`amix`](https://ffmpeg.org/ffmpeg-filters.html#amix) ·
[`concat`](https://ffmpeg.org/ffmpeg-filters.html#concat)

[`split`](https://ffmpeg.org/ffmpeg-filters.html#split_002c-asplit) is similarly not
useful in a single-frame, single-output operation.

## Temporal filters

These need a *stream* of frames. A single-frame operation can't produce meaningful output
from them, even though they're present in the build.

[`fps`](https://ffmpeg.org/ffmpeg-filters.html#fps-1) ·
[`trim`](https://ffmpeg.org/ffmpeg-filters.html#trim) ·
[`setpts`](https://ffmpeg.org/ffmpeg-filters.html#setpts_002c-asetpts) ·
[`yadif`](https://ffmpeg.org/ffmpeg-filters.html#yadif-1) ·
[`bwdif`](https://ffmpeg.org/ffmpeg-filters.html#bwdif-1) · `deinterlace`

To deinterlace or change frame timing, you would need a multi-frame pipeline, which the
current dispatcher does not expose.

## Audio filters

Audio filters are compiled in, but the dispatcher's audio path returns decoded PCM
**without applying the graph** (see the [audio routing caveat](/docs/reference/exec-commands/#audio-routing--af-and--vn)).
They are listed here for completeness:

[`aresample`](https://ffmpeg.org/ffmpeg-filters.html#aresample-1) ·
[`volume`](https://ffmpeg.org/ffmpeg-filters.html#volume) ·
[`atrim`](https://ffmpeg.org/ffmpeg-filters.html#atrim) ·
[`asetpts`](https://ffmpeg.org/ffmpeg-filters.html#setpts_002c-asetpts) ·
[`aecho`](https://ffmpeg.org/ffmpeg-filters.html#aecho) ·
[`highpass`](https://ffmpeg.org/ffmpeg-filters.html#highpass) ·
[`lowpass`](https://ffmpeg.org/ffmpeg-filters.html#lowpass) ·
[`equalizer`](https://ffmpeg.org/ffmpeg-filters.html#equalizer) ·
[`anull`](https://ffmpeg.org/ffmpeg-filters.html#anull)

Process audio in the Web Audio graph after [decoding to PCM](/docs/guides/decode-audio/)
instead.

## Passthrough

[`null`](https://ffmpeg.org/ffmpeg-filters.html#null) (video) and
[`anull`](https://ffmpeg.org/ffmpeg-filters.html#anull) (audio) pass frames through
unchanged, no parameters — occasionally useful as explicit no-ops in a graph.

## Adding a filter

The filter set is defined by the `filters` array in the active preset. To enable one that
isn't listed, add it and rebuild — see [Configuration](/docs/build/configuration/#add-a-preset).
Enabling a filter only makes it *available* to the filtergraph parser; whether it produces
useful output through the single-frame dispatcher is the separate question the sections
above answer.
