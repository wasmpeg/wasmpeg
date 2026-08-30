---
title: "Encode & thumbnails"
description: "Encode frames to JPEG, PNG, or another image codec — grab a single-frame thumbnail from a video, or push your own pixels."
weight: 50
---
`wasmpeg.encode()` runs frames through an encoder and returns the encoded container bytes
as a `Uint8Array`. Its main job is grabbing thumbnails — a single encoded image from a
video frame or a canvas — but it will also encode a run of frames into a multi-image
output.

{{< aside type="note" >}}
wasmpeg is decode-first. `encode()` is built for single frames and image output, not full
video transcoding. There's no file-to-file `-i in.mp4 out.webm` path, and H.264/H.265
*encode* isn't in the default build. For everything `encode()` can do, the source is
decoded to RGBA8 frames and those frames are re-encoded.
{{< /aside >}}

## Synopsis

```js
const bytes = await wasmpeg.encode(input, options?);
// → Uint8Array of the encoded container
```

## Description

`encode()` accepts the same inputs as the rest of the API. For encoded media (`File`,
`Blob`, URL, `Uint8Array`, `ArrayBuffer`) it opens a decoder, pulls frames, and feeds them
to the encoder. For raw pixels (`canvas`, `HTMLVideoElement`, `ImageData`) it skips
decoding and encodes the pixels straight through — exactly one frame.

By default it encodes with the `mjpeg` codec into the `image2pipe` muxer, which writes a
single stream to wasmpeg's in-memory IO. The result is the full container as a
`Uint8Array`, ready to wrap in a `Blob`.

Frame count is up to you. Pass `frames: 1` for a single thumbnail, a higher number to cap
the run, or omit it to encode every decoded frame. Width and height default to the source
size; set them to resize while encoding.

## Parameters

`encode(input, options?)` — all options are optional.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `codec` | string | `'mjpeg'` | Encoder name — `'mjpeg'`, `'png'`, `'gif'`, `'bmp'`, `'tiff'`, … |
| `fmt` | string | `'image2pipe'` | Container / muxer. The default pipe muxer writes a single stream to in-memory IO. |
| `width` | number | source width | Output width in pixels. |
| `height` | number | source height | Output height in pixels. |
| `fps` | number \| `{num,den}` | `30` | Frame rate used for output timestamps. |
| `bitrate` | number | `0` | Target bitrate in bits/s (`0` = codec default). |
| `frames` | number | all | Maximum number of frames to encode. |
| `format` | string | inferred | Force the *input* demuxer (for non-probing formats). |

Two of these are easy to mix up: `fmt` is the output muxer (what you're writing), while
`format` is the input demuxer hint (how the source is read). They're different stages.

## First-frame thumbnail

{{< steps >}}
{{% step %}}
Load and encode the first frame as JPEG.

   ```js
   import wasmpeg from 'wasmpeg';
   await wasmpeg.load();

   const jpg = await wasmpeg.encode(file, { codec: 'mjpeg', frames: 1 });
   ```
{{% /step %}}
{{% step %}}
Turn the bytes into something usable.

   ```js
   const blob = new Blob([jpg], { type: 'image/jpeg' });
   const url  = URL.createObjectURL(blob);
   img.src = url;   // remember to URL.revokeObjectURL(url) when done
   ```
{{% /step %}}
{{< /steps >}}

`frames: 1` stops after the first decoded frame. Omit it to encode every frame in the
source.

## Encode a canvas

Raw-pixel inputs encode with no decode step. This grabs whatever's currently on the canvas
and returns a PNG:

```js
const png = await wasmpeg.encode(canvas, { codec: 'png' });
const blob = new Blob([png], { type: 'image/png' });
```

A `canvas`, `HTMLVideoElement`, or `ImageData` is always a single frame, so `frames` has
no effect on these inputs.

## Resize while encoding

Set `width` and `height` to encode at a different size than the source:

```js
const thumb = await wasmpeg.encode(file, {
    codec: 'mjpeg',
    width: 320,
    height: 180,
    frames: 1,
});
```

The resize happens on decode — the frame is scaled to the target before it reaches the
encoder, so there's no full-size intermediate.

## Choose a codec and format

The codec sets the image format; pick the muxer that goes with it. `image2pipe` works for
the single-stream image codecs:

```js
const png  = await wasmpeg.encode(file, { codec: 'png',  frames: 1 });
const bmp  = await wasmpeg.encode(file, { codec: 'bmp',  frames: 1 });
const tiff = await wasmpeg.encode(file, { codec: 'tiff', frames: 1 });
```

`mjpeg` is the smallest output for photographic frames; `png` is lossless and the right
pick for UI screenshots or anything with sharp edges; `bmp` and `tiff` are uncompressed or
lightly compressed and mostly useful when a downstream tool requires them.

{{< aside type="caution" title="Use image2pipe, not image2" >}}
The default `fmt` is `image2pipe`. The plain `image2` muxer expects numbered files on a
real filesystem and can't write to wasmpeg's in-memory IO — passing it for in-memory
encode fails. Keep the default `image2pipe` (or pass it explicitly) for image output.
{{< /aside >}}

## Encoders in the default build

For video frames the default build ships `mjpeg`, `png`, `gif`, `bmp`, `tiff`, `tga`,
`dpx`, `huffyuv`, and `ffv1`, plus audio encoders (`aac`, `opus`, `flac`, `mp2`,
`wavpack`, and PCM / ADPCM variants). H.264 / H.265 *encode* is GPL-only and ships in
`wasmpeg-full`. The [codec table](/docs/formats/codecs/) has the complete list and which build each
encoder belongs to.

## Notes

- The return value is the full container, not a bare bitstream — for `image2pipe` that's a
  single image you can use directly.
- Encoding a media source opens a decoder internally and frees it for you when `encode()`
  resolves; you don't manage a session slot here.
- For codecs that ignore `bitrate` (the lossless image codecs), the value is a no-op —
  leave it at the default `0`.

## See also

- [Scale & filter a frame](/docs/guides/scale-filter/) — filter a frame before encoding it.
- [Decode video frames](/docs/guides/decode-video/) — pull frames yourself for finer control.
- [Codec & format support](/docs/formats/codecs/) — the full encoder list per build.
