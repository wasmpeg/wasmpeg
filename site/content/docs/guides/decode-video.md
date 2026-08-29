---
title: "Decode video frames"
description: "Open a decoder, pull RGBA8 frames one at a time, optionally scale on decode, render to a canvas, and free the session slot when you're done."
weight: 10
---
`wasmpeg.decode()` opens a video decoder and hands back a frame iterator. You pull
frames one at a time with `nextFrame()`, and each call returns a `Uint8ClampedArray` of
RGBA8 pixels — the exact byte layout that `ImageData` and `texImage2D` accept, so there's
no conversion step between the decoder and the screen.

The iterator is lazy. Nothing is decoded until you ask for a frame, and only one frame
lives in memory at a time. That keeps the footprint flat whether the clip is two seconds
or two hours.

## Synopsis

```js
const dec = await wasmpeg.decode(input, options?);

dec.width                     // number — frame width in pixels
dec.height                    // number — frame height in pixels
dec.fps                       // number — fps_num / fps_den
dec.nextFrame(dstW?, dstH?)   // Uint8ClampedArray (RGBA8) | null at EOF
dec.close()                   // void — frees the session slot
```

## Description

`decode()` accepts any of wasmpeg's encoded input types: a `File`, a `Blob`, an
`http(s)` URL string, a `Uint8Array`, or an `ArrayBuffer`. It does not take raw pixel
sources (a canvas, a video element, or `ImageData`) — there's nothing to demux there, so
that's a thrown error pointing you at [`scale()`](/docs/guides/scale-filter/) instead.

Opening a decoder reads the container header and the first packets needed to set up the
video stream, then stops. The `width`, `height`, and `fps` properties are available
immediately, before you pull a single frame. From there, every `nextFrame()` advances the
stream by one decoded picture and converts it to RGBA8.

When the stream is exhausted, `nextFrame()` returns `null`. That's your loop's exit
condition. After the loop, call `close()` — see [Session slots](#session-slots) for why
that matters.

## Parameters

`decode(input, options?)`

- **`input`** — the media to decode. One of `File`, `Blob`, URL string, `Uint8Array`, or
  `ArrayBuffer`.
- **`options.format`** — optional demuxer name to force, for formats that can't be
  identified by content alone. See [Forcing a demuxer](#forcing-a-demuxer).

`nextFrame(dstW?, dstH?)`

- **`dstW`, `dstH`** — optional target dimensions. When both are given, the frame is
  scaled to that size during decode. Omit them to get the frame at native resolution. The
  two arguments go together; pass both or neither.

## Basic loop

{{< steps >}}
{{% step %}}
Load the module once, at startup.

   ```js
   import wasmpeg from 'wasmpeg';
   await wasmpeg.load();
   ```
{{% /step %}}
{{% step %}}
Open a decoder and read its dimensions.

   ```js
   const dec = await wasmpeg.decode(file);   // File / Blob / URL / Uint8Array / ArrayBuffer
   console.log(dec.width, dec.height, dec.fps);
   ```
{{% /step %}}
{{% step %}}
Pull frames until the stream ends, then close.

   ```js
   let frame;
   while ((frame = dec.nextFrame())) {
       // frame.length === dec.width * dec.height * 4
   }
   dec.close();
   ```
{{% /step %}}
{{< /steps >}}

The `while ((frame = dec.nextFrame()))` idiom works because the iterator returns a
truthy typed array for every frame and a falsy `null` at the end. Always reach the
`close()`.

## Render to a canvas

A decoded frame drops straight into `putImageData` with no copy or color conversion:

```js
const canvas = document.querySelector('canvas');
canvas.width = dec.width;
canvas.height = dec.height;
const ctx = canvas.getContext('2d');

let frame;
while ((frame = dec.nextFrame())) {
    ctx.putImageData(new ImageData(frame, dec.width, dec.height), 0, 0);
    await new Promise(requestAnimationFrame);   // pace to the display
}
dec.close();
```

The `await new Promise(requestAnimationFrame)` paces the loop to the display's refresh.
Without it the loop decodes as fast as it can and you only ever see the last frame.

{{< aside type="note" >}}
wasmpeg decodes; it doesn't schedule playback. The decoder has no concept of presentation
timestamps or a clock, so it won't drop or duplicate frames to hit real-time. If you need
audio-synced playback, drive the loop from your own clock and pull frames to match.
{{< /aside >}}

## Decode straight to a target size

Pass a width and height to `nextFrame()` to scale during decode. This runs a single scale
(on the GPU when WebGPU is available) with no intermediate full-size copy — the right
move for thumbnails or for fitting a fixed viewport.

```js
const thumb = dec.nextFrame(320, 180);   // RGBA8 at 320×180
```

The returned array is sized to the target: `dstW * dstH * 4` bytes. Scaling on decode is
cheaper than decoding at full resolution and shrinking afterward, because the full-size
frame never leaves the decoder.

{{< aside type="tip" >}}
The scale target can change between calls — the decoder rebuilds its scaler only when the
dimensions actually change, so a steady size costs nothing extra. That makes it cheap to,
say, decode most of a clip at thumbnail size and pull one frame at full resolution.
{{< /aside >}}

## Upload frames to WebGL

RGBA8 is also the native upload format for a texture, so the loop maps cleanly onto
`texImage2D` / `texSubImage2D`:

```js
const tex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, tex);

let frame;
while ((frame = dec.nextFrame())) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, dec.width, dec.height, 0,
                  gl.RGBA, gl.UNSIGNED_BYTE, frame);
    // ...draw...
}
dec.close();
```

Reuse a single texture across frames and switch to `texSubImage2D` once the size is
fixed; that avoids reallocating GPU storage on every frame.

## Forcing a demuxer

Most containers identify themselves from a few bytes of header, and wasmpeg detects them
automatically. Some don't — many legacy and game audio/video formats carry no magic
bytes, so the only reliable signal is the filename. Pass `format` to name the demuxer
directly:

```js
const dec = await wasmpeg.decode(bytes, { format: 'dnxhd' });
```

When the input arrives as a `File` or URL with a recognizable extension, wasmpeg derives
the hint from the name on its own, so you rarely need to set this by hand. A raw
`Uint8Array` has no filename, which is the case where forcing the format earns its keep.

## Return shape

```ts
dec.width      // number — frame width in pixels
dec.height     // number — frame height in pixels
dec.fps        // number — fps_num / fps_den
dec.nextFrame(dstW?, dstH?)  // Uint8ClampedArray (RGBA8) | null at EOF
dec.close()                  // void — frees the session slot
```

`fps` is a single number — the source's `fps_num / fps_den` collapsed into one value. If
you need the exact rational (for example, `30000/1001` rather than `29.97`), read it from
[`probe()`](/docs/guides/probe/), which reports `fpsNum` and `fpsDen` separately.

## Session slots

There are 8 shared session slots, pooled across decode, audio decode, and probe. A
decoder holds one slot from `decode()` until `close()`. Forget to close, and the slot
leaks; open enough of them and you'll hit `ENOMEM (-12)`.

```js
// Process a batch of clips — close each decoder before opening the next.
for (const file of files) {
    const dec = await wasmpeg.decode(file);
    const thumb = dec.nextFrame(160, 90);
    saveThumb(thumb);
    dec.close();          // release the slot before the next iteration
}
```

{{< aside type="caution" title="Always close, even on error" >}}
If decoding can throw partway through, wrap the work in `try` / `finally` so the slot is
released no matter what:

```js
const dec = await wasmpeg.decode(file);
try {
    let frame;
    while ((frame = dec.nextFrame())) {
        // ...
    }
} finally {
    dec.close();
}
```
{{< /aside >}}

See the [error reference](/docs/reference/errors/) for what the negative return codes mean.

## See also

- [Scale & filter a frame](/docs/guides/scale-filter/) — one-shot frame processing without
  managing a decoder.
- [Probe metadata](/docs/guides/probe/) — read dimensions, duration, and stream layout before
  you decide to decode.
- [Decode audio to PCM](/docs/guides/decode-audio/) — the matching iterator for audio streams.
