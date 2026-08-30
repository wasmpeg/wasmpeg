---
title: "Codec & format support"
description: "Every decoder, encoder, demuxer, muxer, and image format compiled into the default wasmpeg build, grouped by family, with how compatibility is measured."
weight: 10
---
This is the complete list of components compiled into the default **LGPL** build of
wasmpeg, grouped by family. The selection is data-driven — it lives in the `lgpl` preset
in `src/cli/configure.mjs` — so a custom build may enable more or fewer. To check what a
particular binary actually contains, see [Configuration & presets](/docs/build/configuration/).

Use this page the way you'd use FFmpeg's own `-decoders` / `-formats` output: scan for the
name you need, confirm which side of the decode/encode line it sits on, and follow through
to the [compatibility report](/docs/formats/compatibility/) if you care about bit-exact results. A
component being listed here means it's *compiled in* — coverage and correctness for a given
sample are separate questions answered by the live report.

## How to read this page

The build is decode-first, so the lists break down roughly like this:

| Category | Coverage in this build |
|----------|------------------------|
| Video / audio / image **decoders** | Broad — modern web codecs through to a long tail of legacy and game formats |
| **Demuxers** (input containers) | Broad — matches the decoder spread |
| **Encoders** | Narrow — image codecs plus a handful of audio codecs; no inter-frame video encode |
| **Muxers** (output containers) | Narrow — sized to the encoder set |

If you only want to know whether wasmpeg can *open and read* a file, look at the decoder and
demuxer sections. If you want to *write* a file back out, look at the encoder and muxer
sections — that's the smaller side.

{{< aside type="note" title="Decode-first" >}}
wasmpeg is built to get pixels, samples, and metadata out of media. The decoder and
demuxer coverage is broad; the encoder and muxer coverage is intentionally narrow
(image codecs for thumbnails, a handful of audio codecs). H.264/H.265 **decode** is in
this build; H.264/H.265 **encode** is GPL-only (`wasmpeg-full`).
{{< /aside >}}

## Video decoders

### Modern web video

`h264` · `hevc` (H.265) · `vp8` · `vp9` · `av1`

The codecs you will hit most often on the web. H.264 and HEVC decode are included here in
the LGPL build.

### Classic and broadcast

`mpeg1video` · `mpeg2video` · `mpeg4` · `h263` · `h261`

MPEG-1/2 for DVD and broadcast streams, MPEG-4 Part 2, and the H.26x video-conferencing
codecs.

### Microsoft

`msmpeg4v1` · `msmpeg4v2` · `msmpeg4v3` · `wmv1` · `wmv2` · `wmv3` · `vc1` · `mss2`

Windows Media Video 7–9, VC-1, and the MS-MPEG4 variants found in older AVI/ASF files.

### Apple and QuickTime

`prores` · `qtrle` · `svq1` · `svq3` · `rpza` · `smc`

Apple ProRes, QuickTime Animation (RLE), Sorenson Video, and the early QuickTime codecs.

### Professional and broadcast

`dnxhd` (DNxHD/DNxHR) · `mjpeg` · `mjpegb` · `cfhd` (CineForm)

Editing and acquisition codecs used in professional workflows.

### Lossless and archival

`huffyuv` · `ffv1` · `ffvhuff` · `utvideo` · `magicyuv` · `lagarith` · `hap`

Lossless intermediate and archival codecs. FFV1 is the common choice for preservation.

### Screen capture and lossless AVI/MOV

`dxtory` · `fic` · `fmvc` · `frwu` · `mszh` · `zlib` · `lscr` · `rscc` · `tscc` ·
`tscc2` · `vble` · `zerocodec` · `mwsc` · `screenpresso` · `g2meet` · `mss1` · `lead` ·
`dxv` · `aic`

TechSmith, Camtasia, and other screen-recording and lossless-ish codecs.

### Legacy and game video

`theora` · `vp3` · `vp4` · `vp5` · `vp6` · `vp6a` · `vp6f` · `vp7` · `rv10` · `rv20` ·
`rv30` · `rv40` · `rv60` · `flashsv` · `flashsv2` · `cinepak` · `msvideo1` · `fraps` ·
`cdxl` · `flic` · `zmbv` · `cllc` · `hq_hqa` · `hqx` · `speedhq` · `truemotion1` ·
`truemotion2` · `truemotion2rt` · `mimic` · `mdec` · `roqvideo` · `dirac` · `cavs` ·
`smacker` · `bmv_video` · `vmdvideo` · `paf_video` · `idcin` · `dsicinvideo` ·
`bethsoftvid` · `bfi` · `tmv` · `rl2` · `c93` · `dfa` · `fourxm` · `jv` · `vb` · `dxa` ·
`kmvc` · `motionpixels` · `mvc1` · `mvc2` · `escape124` · `escape130`

On2/Truemotion, RealVideo, Sorenson/Flash, id Software, Bink, Smacker, and a long tail of
multimedia and game-engine codecs carried for FATE coverage.

### Intel, vendor, and miscellaneous

`indeo2` · `indeo3` · `indeo4` · `indeo5` · `loco` · `msrle` · `dvvideo` · `aura` ·
`aura2` · `cljr` · `cyuv` · `ulti` · `vcr1` · `xl` · `wnv1` · `vqc` · `xan_wc3` ·
`xan_wc4` · `eamad` · `eatgq` · `sgirle` · `nuv` · `thp` · `txd` · `mts2` · `avui` ·
`avrn` · `qpeg` · `sp5x` · `aasc` · `ansi` · `cscd` · `tdsc` · `qdraw` · `pixlet` ·
`cdgraphics` · `brender_pix`

### Raw packed-pixel

`r210` · `v210` · `v410` · `r10k`

Uncompressed 10-bit packed formats found in `.avi`/`.mov` captures.

## Image formats

`png` · `apng` · `gif` · `bmp` · `tiff` · `webp` · `tga` / `targa` · `dpx` · `xbm` ·
`sunrast` · `xface` · `jpeg2000` · `jpegls` · `exr` · `psd` · `mjpeg` (JPEG)

Still-image decoders. PNG, JPEG, WebP, and GIF cover the common cases; the rest support
EXR, Photoshop PSD, JPEG-2000, and legacy raster formats.

{{< aside type="tip" >}}
Single-frame images decode most reliably through a file path (`createDecoderFile`) or by
forcing the `image2` demuxer — the pipe demuxers can fail to resolve dimensions for a
lone image. The high-level `decode()` handles this for you.
{{< /aside >}}

## Audio decoders

### Modern

`aac` · `aac_latm` · `opus` · `mp3` · `mp2` · `mp1` · `vorbis` · `flac`

### Surround and professional

`ac3` · `ac3_fixed` · `eac3` (E-AC-3) · `dca` (DTS) · `truehd` · `mlp`

Dolby and DTS family, including Dolby TrueHD and Meridian Lossless Packing.

### Lossless

`alac` · `wavpack` · `ape` (Monkey's Audio) · `tta` · `shorten`

### Microsoft

`wmav1` · `wmav2` · `wmapro` · `wmalossless` · `wmavoice`

### PCM

`pcm_s8` · `pcm_u8` · `pcm_s16le` · `pcm_s16be` · `pcm_u16le` · `pcm_u16be` ·
`pcm_s24le` · `pcm_s24be` · `pcm_u24le` · `pcm_u24be` · `pcm_s32le` · `pcm_s32be` ·
`pcm_u32le` · `pcm_u32be` · `pcm_f32le` · `pcm_f32be` · `pcm_f64le` · `pcm_f64be` ·
`pcm_mulaw` · `pcm_alaw` · `pcm_dvd` · `pcm_bluray` · `pcm_vidc`

All signed/unsigned/float PCM variants, plus µ-law/A-law and the DVD/Blu-ray packings.

### ADPCM

Common: `adpcm_ms` · `adpcm_ima_wav` · `adpcm_ima_qt` · `adpcm_swf` · `adpcm_yamaha` ·
`adpcm_thp` · `adpcm_g726` · `adpcm_g726le` · `adpcm_g722`

Game and vendor variants: `adpcm_4xm` · `adpcm_afc` · `adpcm_dtk` · `adpcm_ea` ·
`adpcm_ea_maxis_xa` · `adpcm_ea_r1` · `adpcm_ea_r2` · `adpcm_ea_r3` · `adpcm_ima_amv` ·
`adpcm_ima_apc` · `adpcm_ima_dk3` · `adpcm_ima_dk4` · `adpcm_ima_ea_eacs` ·
`adpcm_ima_ea_sead` · `adpcm_ima_iss` · `adpcm_ima_oki` · `adpcm_ima_rad` ·
`adpcm_ima_smjpeg` · `adpcm_ima_ws` · `adpcm_argo` · `adpcm_sanyo` · `adpcm_vima` ·
`adpcm_xa` · `adpcm_sbpro_2` · `adpcm_sbpro_3` · `adpcm_sbpro_4`

### DPCM

`roq_dpcm` · `interplay_dpcm` · `sol_dpcm` · `xan_dpcm`

### Speech and telephony

`speex` · `nellymoser` · `amrnb` · `amrwb` · `g722` · `g723_1` · `g726` · `g728` ·
`gsm` · `gsm_ms` · `qcelp` · `sipr` · `truespeech` · `dss_sp`

### Sony, Bink, and niche

`atrac1` · `atrac3` · `atrac3p` · `imc` · `cook` · `ra_144` · `ra_288` · `twinvq` ·
`dolby_e` · `dst` · `mpc7` · `mpc8` · `mace3` · `mace6` · `binkaudio_dct` ·
`binkaudio_rdft` · `qdm2` · `qoa` · `tak` · `smackaud` · `paf_audio` · `vmdaudio` ·
`bmv_audio` · `dsicinaudio` · `msnsiren` · `dsd_lsbf` · `dsd_msbf`

## Video encoders

`mjpeg` · `png` · `gif` · `bmp` · `tiff` · `tga` · `dpx` · `huffyuv` · `ffv1`

Image-oriented encoders for thumbnails and frame export, plus two intra-frame video
codecs (`huffyuv`, `ffv1`) that write one independently-coded frame at a time. There is no
inter-frame (P/B-frame) video encoder in the LGPL build; H.264/H.265 encode lives in
`wasmpeg-full`. See [the GPL build](#the-gpl-build-wasmpeg-full) below.

## Audio encoders

`aac` · `opus` · `flac` · `mp2` · `wavpack` · `wmav1` · `wmav2` · `eac3` · `ac3_fixed` ·
`pcm_s16le` · `pcm_s24le` · `pcm_f32le` · `pcm_mulaw` · `pcm_alaw` · `adpcm_ms` ·
`adpcm_ima_wav`

All of these are FFmpeg built-ins — no external library is linked — which is what keeps the
default build LGPL-clean.

## The GPL build (wasmpeg-full)

Everything above is the **LGPL** build. The `gpl` preset (`wasmpeg-full`) inherits the
entire LGPL component set and extends it; it never drifts from this list because it's
defined as `[...lgpl, ...extras]` in `configure.mjs`. The intended extras are H.264 and
H.265 **encode** via `libx264` / `libx265`, which are GPL-licensed external libraries.

{{< aside type="caution" >}}
Linking the GPL binary into a closed-source product carries GPL obligations. The `libx264`
/ `libx265` encoders are scaffolded in the `gpl` preset and gated behind the external-lib
flags; consult `src/cli/configure.mjs` and the build docs for the current state before
relying on them. Decode coverage is identical between the two builds.
{{< /aside >}}

## Containers (demuxers)

### Major containers

`mov` (MP4/MOV) · `matroska` (MKV/WebM) · `avi` · `ogg` · `asf` (WMV/WMA) · `flv` ·
`rm` (RealMedia) · `mxf` · `dv`

### Audio containers

`mp3` · `wav` · `flac` · `aac` · `ac3` · `eac3` · `dts` · `truehd` · `mlp` · `amr` ·
`g722` · `g723_1` · `g726` · `gsm` · `wv` (WavPack) · `ape` · `oma` (Sony OMA/AA3) ·
`tta` · `mpc` · `qcp` · `vqf` · `xwma` · `dsf` · `shorten` · `aea` · `brstm` · `bfstm`

### Raw bitstreams

`h264` · `hevc` · `h263` · `h261` · `av1` · `ivf` · `m4v` · `mpegps` · `mpegvideo` ·
`mpegts` · `rawvideo` · `vc1` · `vc1t` · `dnxhd` · `cavsvideo` · `dirac` · `eac3`

### Image pipes

`image2` · `image2pipe` · `image_png_pipe` · `image_bmp_pipe` · `image_gif_pipe` ·
`image_tiff_pipe` · `image_webp_pipe` · `image_j2k_pipe` · `image_jpeg_pipe` ·
`image_jpegls_pipe` · `image_exr_pipe` · `image_psd_pipe` · `image_dpx_pipe` ·
`image_tga_pipe` · `image_xbm_pipe` · `image_sunrast_pipe` · `image_xface_pipe`

{{< aside type="caution" title="Demuxer naming" >}}
The `--enable-demuxer=` name and the runtime `av_find_input_format()` name differ for
image pipes (`image_png_pipe` vs `png_pipe`). See
[Configuration](/docs/build/configuration/#the-image-pipe-naming-trap).
{{< /aside >}}

### Game and multimedia

`bink` · `binka` · `cdxl` · `nuv` · `thp` · `txd` · `mv` · `apng` · `dfa` · `paf` ·
`vmd` · `fits` · `qoa` · `bmv` · `dsicin` · `smacker` · `jv` · `siff` · `ipmovie` ·
`dss` · `tak` · `rl2` · `c93` · `cdg` · `bethsoftvid` · `bfi` · `tmv` · `mm` · `idcin` ·
`yop` · `ea` · `ea_cdata` · `flic` · `fourxm` · `ast` · `voc` · `amv` · `apc` ·
`wsvqa` · `iss` · `rsd` · `smjpeg` · `smush` · `roq` · `mve` · `sol` · `xa` · `str` ·
`dxa` · `kvag` · `apm` · `alp` · `pp_bnk` · `argo_asf` · `rpl` · `s337m` · `g728` ·
`concat` · `wtv`

### PCM raw demuxers

`pcm_s8` · `pcm_u8` · `pcm_s16le` · `pcm_s16be` · `pcm_u16le` · `pcm_u16be` ·
`pcm_s24le` · `pcm_s24be` · `pcm_u24le` · `pcm_u24be` · `pcm_s32le` · `pcm_s32be` ·
`pcm_u32le` · `pcm_u32be` · `pcm_f32le` · `pcm_f32be` · `pcm_f64le` · `pcm_f64be` ·
`pcm_mulaw` · `pcm_alaw` · `pcm_vidc`

## Output containers (muxers)

`mp4` · `webm` · `ogg` · `matroska` · `avi` · `flv` · `asf` · `mpegts` · `wav` ·
`flac` · `ac3` · `adts` · `opus` · `truehd` · `image2` · `image2pipe` · `mjpeg` ·
`apng` · `gif` · `webp` · `null` · `pcm_s16le` · `pcm_f32le` · `pcm_mulaw` · `pcm_alaw`

{{< aside type="note" >}}
Muxers are used by the [encoder](/docs/reference/gpu/#createencoder) for image and audio
output. `image2pipe` is the default for in-memory image encode — `image2` expects numbered
files on a real filesystem.
{{< /aside >}}

## Measuring compatibility

wasmpeg is tracked against FFmpeg's FATE sample suite on two axes:

- **Coverage** — does a sample decode without erroring? Generated by `tests/compat.mjs`
  into `COMPAT.md`.
- **Correctness** — does the decode match FFmpeg byte-for-byte? Each frame's checksum is
  compared against FFmpeg's own vendored reference output by `tests/fate.mjs` into
  `CORRECTNESS.md`.

Correctness is the number that matters: not "does it run," but "does it produce the exact
right pixels." See the **[live Compatibility page](/docs/formats/compatibility/)** for the current
overall figures and a per-codec breakdown, charted from those reports.

## Requesting a codec

If a format does not content-probe, force its demuxer with
[`decode(input, { format })`](/docs/guides/decode-video/#forcing-a-demuxer). If a codec is
genuinely not in your build, decoding fails with
[`AVERROR_DECODER_NOT_FOUND`](/docs/reference/errors/); add it to a preset and rebuild per
[Configuration](/docs/build/configuration/#add-a-preset).
