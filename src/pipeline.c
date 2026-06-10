/*
 * Generic FFmpeg filter + decoder + audio + encode + probe pipeline for WASM.
 *
 * New GPU filters slot in via the filtergraph string — no changes to this
 * file needed. Compile with build-cpu.sh or build-webgpu.sh.
 */

#include <string.h>
#include <emscripten.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>
#include <libavutil/imgutils.h>
#include <libavutil/log.h>
#include <libavutil/mathematics.h>
#include <libavutil/opt.h>
#include <libavutil/pixfmt.h>
#include <libavutil/hwcontext.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>

/* ------------------------------------------------------------------ version */

EMSCRIPTEN_KEEPALIVE
const char *pipeline_version(void) { return av_version_info(); }

/* -------------------------------------------------------- internal helpers */

static AVFilterGraph *build_graph(const char *filtergraph,
                                  int src_w, int src_h,
                                  enum AVPixelFormat src_fmt,
                                  AVBufferRef *hw_frames_ctx,
                                  AVFilterContext **src_out,
                                  AVFilterContext **sink_out)
{
    AVFilterGraph *graph = avfilter_graph_alloc();
    if (!graph) return NULL;

    char src_args[192];
    snprintf(src_args, sizeof(src_args),
             "video_size=%dx%d:pix_fmt=%d:time_base=1/25:pixel_aspect=1/1",
             src_w, src_h, src_fmt);

    AVFilterContext *src_ctx  = NULL;
    AVFilterContext *sink_ctx = NULL;
    int ret;

    ret = avfilter_graph_create_filter(&src_ctx,
              avfilter_get_by_name("buffer"), "in", src_args, NULL, graph);
    if (ret < 0) goto fail;

    if (hw_frames_ctx) {
        AVBufferSrcParameters *par = av_buffersrc_parameters_alloc();
        if (!par) { ret = AVERROR(ENOMEM); goto fail; }
        par->hw_frames_ctx = av_buffer_ref(hw_frames_ctx);
        ret = av_buffersrc_parameters_set(src_ctx, par);
        av_free(par);
        if (ret < 0) goto fail;
    }

    ret = avfilter_graph_create_filter(&sink_ctx,
              avfilter_get_by_name("buffersink"), "out", NULL, NULL, graph);
    if (ret < 0) goto fail;

    AVFilterInOut *inputs  = avfilter_inout_alloc();
    AVFilterInOut *outputs = avfilter_inout_alloc();
    if (!inputs || !outputs) { avfilter_inout_free(&inputs); avfilter_inout_free(&outputs); goto fail; }

    outputs->name       = av_strdup("in");
    outputs->filter_ctx = src_ctx;
    outputs->pad_idx    = 0;
    outputs->next       = NULL;

    inputs->name        = av_strdup("out");
    inputs->filter_ctx  = sink_ctx;
    inputs->pad_idx     = 0;
    inputs->next        = NULL;

    ret = avfilter_graph_parse_ptr(graph, filtergraph, &inputs, &outputs, NULL);
    avfilter_inout_free(&inputs);
    avfilter_inout_free(&outputs);
    if (ret < 0) goto fail;

    ret = avfilter_graph_config(graph, NULL);
    if (ret < 0) goto fail;

    *src_out  = src_ctx;
    *sink_out = sink_ctx;
    return graph;

fail:
    avfilter_graph_free(&graph);
    return NULL;
}

/* -------------------------------------------------- CPU pipeline (RGBA in/out) */

EMSCRIPTEN_KEEPALIVE
int pipeline_run_rgba(const uint8_t *src_rgba, int src_w, int src_h,
                      uint8_t *dst_rgba,       int dst_w, int dst_h,
                      const char *filtergraph)
{
    AVFilterGraph   *graph    = NULL;
    AVFilterContext *src_ctx  = NULL, *sink_ctx = NULL;
    AVFrame         *in = NULL, *out = NULL;
    int ret = -1;

    in = av_frame_alloc();
    if (!in) return AVERROR(ENOMEM);
    in->format = AV_PIX_FMT_RGBA;
    in->width  = src_w;
    in->height = src_h;
    if (av_frame_get_buffer(in, 0) < 0) goto done;
    av_image_copy_plane(in->data[0], in->linesize[0],
                        src_rgba, src_w * 4, src_w * 4, src_h);

    graph = build_graph(filtergraph, src_w, src_h, AV_PIX_FMT_RGBA,
                        NULL, &src_ctx, &sink_ctx);
    if (!graph) goto done;

    if (av_buffersrc_add_frame_flags(src_ctx, in, AV_BUFFERSRC_FLAG_KEEP_REF) < 0)
        goto done;

    out = av_frame_alloc();
    if (!out || av_buffersink_get_frame(sink_ctx, out) < 0) goto done;

    if (out->format != AV_PIX_FMT_RGBA) {
        struct SwsContext *sws = sws_getContext(
            out->width, out->height, out->format,
            dst_w, dst_h, AV_PIX_FMT_RGBA,
            SWS_BILINEAR, NULL, NULL, NULL);
        if (!sws) goto done;
        uint8_t *dst_data[1] = { dst_rgba };
        int dst_stride[1]    = { dst_w * 4 };
        sws_scale(sws, (const uint8_t *const *)out->data, out->linesize,
                  0, out->height, dst_data, dst_stride);
        sws_freeContext(sws);
    } else {
        av_image_copy_plane(dst_rgba, dst_w * 4,
                            out->data[0], out->linesize[0],
                            dst_w * 4, dst_h);
    }
    ret = 0;

done:
    av_frame_free(&in);
    av_frame_free(&out);
    avfilter_graph_free(&graph);
    return ret;
}

/* ----------------------------------------------- WebGPU pipeline (RGBA in/out) */

#ifdef CONFIG_WEBGPU
#include <libavutil/hwcontext_webgpu.h>

EMSCRIPTEN_KEEPALIVE
int pipeline_run_rgba_gpu(const uint8_t *src_rgba, int src_w, int src_h,
                           uint8_t *dst_rgba,       int dst_w, int dst_h,
                           const char *filtergraph)
{
    AVBufferRef     *device_ref = NULL, *frames_ref = NULL;
    AVFilterGraph   *graph      = NULL;
    AVFilterContext *src_ctx    = NULL, *sink_ctx = NULL;
    AVFrame         *sw_in  = NULL, *hw_in  = NULL;
    AVFrame         *hw_out = NULL, *sw_out = NULL;
    int ret = -1;

    ret = av_hwdevice_ctx_create(&device_ref, AV_HWDEVICE_TYPE_WEBGPU,
                                 NULL, NULL, 0);
    if (ret < 0) goto done;

    AVBufferRef *fr = av_hwframe_ctx_alloc(device_ref);
    if (!fr) { ret = AVERROR(ENOMEM); goto done; }
    AVHWFramesContext *fc = (AVHWFramesContext *)fr->data;
    fc->format            = AV_PIX_FMT_WEBGPU;
    fc->sw_format         = AV_PIX_FMT_RGBA;
    fc->width             = src_w;
    fc->height            = src_h;
    fc->initial_pool_size = 4;
    ret = av_hwframe_ctx_init(fr);
    if (ret < 0) { av_buffer_unref(&fr); goto done; }
    frames_ref = fr;

    sw_in = av_frame_alloc();
    if (!sw_in) { ret = AVERROR(ENOMEM); goto done; }
    sw_in->format = AV_PIX_FMT_RGBA;
    sw_in->width  = src_w;
    sw_in->height = src_h;
    if (av_frame_get_buffer(sw_in, 0) < 0) goto done;
    av_image_copy_plane(sw_in->data[0], sw_in->linesize[0],
                        src_rgba, src_w * 4, src_w * 4, src_h);

    hw_in = av_frame_alloc();
    if (!hw_in) goto done;
    if (av_hwframe_get_buffer(frames_ref, hw_in, 0) < 0) goto done;
    if (av_hwframe_transfer_data(hw_in, sw_in, 0) < 0) goto done;

    graph = build_graph(filtergraph, src_w, src_h, AV_PIX_FMT_WEBGPU,
                        frames_ref, &src_ctx, &sink_ctx);
    if (!graph) goto done;

    if (av_buffersrc_add_frame_flags(src_ctx, hw_in, AV_BUFFERSRC_FLAG_KEEP_REF) < 0)
        goto done;

    hw_out = av_frame_alloc();
    if (!hw_out || av_buffersink_get_frame(sink_ctx, hw_out) < 0) goto done;

    sw_out = av_frame_alloc();
    if (!sw_out) goto done;
    sw_out->format = AV_PIX_FMT_RGBA;
    sw_out->width  = dst_w;
    sw_out->height = dst_h;
    if (av_frame_get_buffer(sw_out, 0) < 0) goto done;
    if (av_hwframe_transfer_data(sw_out, hw_out, 0) < 0) goto done;

    av_image_copy_plane(dst_rgba, dst_w * 4,
                        sw_out->data[0], sw_out->linesize[0],
                        dst_w * 4, dst_h);
    ret = 0;

done:
    av_frame_free(&sw_in);  av_frame_free(&hw_in);
    av_frame_free(&hw_out); av_frame_free(&sw_out);
    avfilter_graph_free(&graph);
    av_buffer_unref(&frames_ref);
    av_buffer_unref(&device_ref);
    return ret;
}
#endif /* CONFIG_WEBGPU */

/* -------------------------------------------------- shared memory I/O ---- */

typedef struct {
    uint8_t *data;
    size_t   size;
    size_t   pos;
} MemBuf;

static int mem_read(void *opaque, uint8_t *buf, int buf_size)
{
    MemBuf *m = opaque;
    int n = (int)FFMIN((size_t)buf_size, m->size - m->pos);
    if (n <= 0) return AVERROR_EOF;
    memcpy(buf, m->data + m->pos, n);
    m->pos += n;
    return n;
}

static int64_t mem_seek(void *opaque, int64_t offset, int whence)
{
    MemBuf *m = opaque;
    if (whence == AVSEEK_SIZE) return (int64_t)m->size;
    int64_t p;
    if      (whence == SEEK_SET) p = offset;
    else if (whence == SEEK_CUR) p = (int64_t)m->pos + offset;
    else if (whence == SEEK_END) p = (int64_t)m->size + offset;
    else return -1;
    if (p < 0 || (size_t)p > m->size) return -1;
    m->pos = (size_t)p;
    return p;
}

/* Allocate a MemBuf-backed AVIOContext. Caller must free avio_ctx->buffer and
   avio_ctx itself on cleanup (or call avio_cleanup()). */
static AVIOContext *membuf_avio_alloc(MemBuf *m)
{
    uint8_t *buf = av_malloc(65536);
    if (!buf) return NULL;
    AVIOContext *ctx = avio_alloc_context(buf, 65536, 0, m, mem_read, NULL, mem_seek);
    if (!ctx) { av_free(buf); return NULL; }
    return ctx;
}

static void avio_cleanup(AVIOContext **ctx)
{
    if (*ctx) { av_freep(&(*ctx)->buffer); avio_context_free(ctx); }
}

#define MAX_SESSIONS 8

/* -------------------------------------------------- video decoder -------- */

typedef struct {
    int               active;
    MemBuf            membuf;
    AVIOContext      *avio_ctx;
    AVFormatContext  *fmt_ctx;
    AVCodecContext   *codec_ctx;
    AVPacket         *pkt;
    AVFrame          *frame;
    struct SwsContext *sws;
    int               video_stream;
    int               width, height;
    int               fps_num, fps_den;
    int               sws_src_w, sws_src_h;
    enum AVPixelFormat sws_src_fmt;
    int               sws_dst_w, sws_dst_h;
} DecodeSession;

static DecodeSession g_dec[MAX_SESSIONS];

/* Shared post-open setup: find video stream, open codec, alloc pkt+frame. */
static int decoder_setup_video(DecodeSession *s)
{
    int ret = avformat_find_stream_info(s->fmt_ctx, NULL);
    if (ret < 0) return ret;

    s->video_stream = -1;
    for (unsigned i = 0; i < s->fmt_ctx->nb_streams; i++) {
        if (s->fmt_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
            s->video_stream = (int)i;
            break;
        }
    }
    if (s->video_stream < 0) return AVERROR_STREAM_NOT_FOUND;

    AVStream *st = s->fmt_ctx->streams[s->video_stream];
    const AVCodec *codec = avcodec_find_decoder(st->codecpar->codec_id);
    if (!codec) return AVERROR_DECODER_NOT_FOUND;

    s->codec_ctx = avcodec_alloc_context3(codec);
    if (!s->codec_ctx) return AVERROR(ENOMEM);

    ret = avcodec_parameters_to_context(s->codec_ctx, st->codecpar);
    if (ret < 0) return ret;

    ret = avcodec_open2(s->codec_ctx, codec, NULL);
    if (ret < 0) return ret;

    s->width  = s->codec_ctx->width;
    s->height = s->codec_ctx->height;
    if (st->avg_frame_rate.den && st->avg_frame_rate.num) {
        s->fps_num = st->avg_frame_rate.num;
        s->fps_den = st->avg_frame_rate.den;
    } else {
        s->fps_num = 25; s->fps_den = 1;
    }

    s->pkt   = av_packet_alloc();
    s->frame = av_frame_alloc();
    if (!s->pkt || !s->frame) return AVERROR(ENOMEM);

    s->active = 1;
    return 0;
}

static void decoder_cleanup(DecodeSession *s)
{
    sws_freeContext(s->sws);
    av_packet_free(&s->pkt);
    av_frame_free(&s->frame);
    avcodec_free_context(&s->codec_ctx);
    avformat_close_input(&s->fmt_ctx);
    avio_cleanup(&s->avio_ctx);
    av_free(s->membuf.data);
    memset(s, 0, sizeof(*s));
}

static int decoder_open_internal(const uint8_t *data, int size, const char *fmt_name)
{
    int slot = -1;
    for (int i = 0; i < MAX_SESSIONS; i++)
        if (!g_dec[i].active) { slot = i; break; }
    if (slot < 0) return AVERROR(ENOMEM);

    DecodeSession *s = &g_dec[slot];
    memset(s, 0, sizeof(*s));

    s->membuf.data = av_malloc(size);
    if (!s->membuf.data) return AVERROR(ENOMEM);
    memcpy(s->membuf.data, data, size);
    s->membuf.size = size;

    s->avio_ctx = membuf_avio_alloc(&s->membuf);
    if (!s->avio_ctx) { av_free(s->membuf.data); return AVERROR(ENOMEM); }

    s->fmt_ctx = avformat_alloc_context();
    if (!s->fmt_ctx) { decoder_cleanup(s); return AVERROR(ENOMEM); }
    s->fmt_ctx->pb = s->avio_ctx;

    const AVInputFormat *forced = fmt_name ? av_find_input_format(fmt_name) : NULL;
    int ret = avformat_open_input(&s->fmt_ctx, NULL, forced, NULL);
    if (ret < 0) { decoder_cleanup(s); return ret; }

    ret = decoder_setup_video(s);
    if (ret < 0) { decoder_cleanup(s); return ret; }
    return slot;
}

EMSCRIPTEN_KEEPALIVE
int decoder_open(const uint8_t *data, int size)
{
    return decoder_open_internal(data, size, NULL);
}

EMSCRIPTEN_KEEPALIVE
int decoder_open_format(const uint8_t *data, int size, const char *fmt_name)
{
    return decoder_open_internal(data, size, fmt_name);
}

// Open a file from the Emscripten virtual FS by path (avoids custom AVIO).
// Useful for image files (.png, .jpg) where pipe demuxers have probe limits.
EMSCRIPTEN_KEEPALIVE
int decoder_open_file(const char *path)
{
    int slot = -1;
    for (int i = 0; i < MAX_SESSIONS; i++)
        if (!g_dec[i].active) { slot = i; break; }
    if (slot < 0) return AVERROR(ENOMEM);

    DecodeSession *s = &g_dec[slot];
    memset(s, 0, sizeof(*s));

    // Force image2 (file-based, non-pipe) so FFmpeg reads PNG as a still image
    // rather than selecting png_pipe which fails to resolve stream parameters.
    const AVInputFormat *img2 = av_find_input_format("image2");
    int ret = avformat_open_input(&s->fmt_ctx, path, img2, NULL);
    if (ret < 0) { decoder_cleanup(s); return ret; }

    ret = decoder_setup_video(s);
    if (ret < 0) { decoder_cleanup(s); return ret; }
    return slot;
}

EMSCRIPTEN_KEEPALIVE int decoder_width(int h)   { return (h>=0&&h<MAX_SESSIONS&&g_dec[h].active)?g_dec[h].width  :-1; }
EMSCRIPTEN_KEEPALIVE int decoder_height(int h)  { return (h>=0&&h<MAX_SESSIONS&&g_dec[h].active)?g_dec[h].height :-1; }
EMSCRIPTEN_KEEPALIVE int decoder_fps_num(int h) { return (h>=0&&h<MAX_SESSIONS&&g_dec[h].active)?g_dec[h].fps_num:-1; }
EMSCRIPTEN_KEEPALIVE int decoder_fps_den(int h) { return (h>=0&&h<MAX_SESSIONS&&g_dec[h].active)?g_dec[h].fps_den:-1; }

EMSCRIPTEN_KEEPALIVE
int decoder_next_frame(int handle, uint8_t *dst_rgba, int dst_w, int dst_h)
{
    if (handle < 0 || handle >= MAX_SESSIONS || !g_dec[handle].active)
        return AVERROR(EINVAL);
    DecodeSession *s = &g_dec[handle];

    for (;;) {
        int ret = avcodec_receive_frame(s->codec_ctx, s->frame);
        if (ret == 0) {
            int out_w = (dst_w > 0) ? dst_w : s->frame->width;
            int out_h = (dst_h > 0) ? dst_h : s->frame->height;

            if (!s->sws
                || s->sws_src_w   != s->frame->width
                || s->sws_src_h   != s->frame->height
                || s->sws_src_fmt != s->frame->format
                || s->sws_dst_w   != out_w
                || s->sws_dst_h   != out_h) {
                sws_freeContext(s->sws);
                s->sws = sws_getContext(
                    s->frame->width, s->frame->height, s->frame->format,
                    out_w, out_h, AV_PIX_FMT_RGBA,
                    SWS_BILINEAR, NULL, NULL, NULL);
                if (!s->sws) { av_frame_unref(s->frame); return AVERROR(ENOMEM); }
                s->sws_src_w   = s->frame->width;
                s->sws_src_h   = s->frame->height;
                s->sws_src_fmt = s->frame->format;
                s->sws_dst_w   = out_w;
                s->sws_dst_h   = out_h;
            }
            uint8_t *dst_data[1]   = { dst_rgba };
            int      dst_stride[1] = { out_w * 4 };
            sws_scale(s->sws,
                      (const uint8_t *const *)s->frame->data, s->frame->linesize,
                      0, s->frame->height, dst_data, dst_stride);
            s->width  = s->frame->width;
            s->height = s->frame->height;
            av_frame_unref(s->frame);
            return 0;
        }
        if (ret != AVERROR(EAGAIN)) return ret == AVERROR_EOF ? 1 : ret;

        for (;;) {
            ret = av_read_frame(s->fmt_ctx, s->pkt);
            if (ret < 0) {
                avcodec_send_packet(s->codec_ctx, NULL);
                break;
            }
            if (s->pkt->stream_index == s->video_stream) {
                ret = avcodec_send_packet(s->codec_ctx, s->pkt);
                av_packet_unref(s->pkt);
                if (ret < 0) return ret;
                break;
            }
            av_packet_unref(s->pkt);
        }
    }
}

/*
 * Decode the next frame and copy it out in its native pixel format, packed
 * tightly (align=1) the same way FFmpeg's rawvideo encoder / framecrc muxer
 * lays it out. This lets callers reproduce FATE's reference checksums exactly,
 * which decoder_next_frame can't do since it converts to RGBA.
 *
 * Returns the byte count written (>0), 0 at end of stream, or a negative
 * AVERROR. The caller should size dst at width*height*8 to fit any pixel format.
 */
EMSCRIPTEN_KEEPALIVE
int decoder_next_raw_frame(int handle, uint8_t *dst, int dst_cap)
{
    if (handle < 0 || handle >= MAX_SESSIONS || !g_dec[handle].active)
        return AVERROR(EINVAL);
    DecodeSession *s = &g_dec[handle];

    for (;;) {
        int ret = avcodec_receive_frame(s->codec_ctx, s->frame);
        if (ret == 0) {
            int w = s->frame->width, h = s->frame->height;
            enum AVPixelFormat fmt = s->frame->format;
            int size = av_image_get_buffer_size(fmt, w, h, 1);
            if (size < 0)        { av_frame_unref(s->frame); return size; }
            if (size > dst_cap)  { av_frame_unref(s->frame); return AVERROR(ENOMEM); }
            av_image_copy_to_buffer(dst, dst_cap,
                (const uint8_t *const *)s->frame->data, s->frame->linesize,
                fmt, w, h, 1);
            s->width  = w;
            s->height = h;
            av_frame_unref(s->frame);
            return size;
        }
        if (ret != AVERROR(EAGAIN)) return ret == AVERROR_EOF ? 0 : ret;

        for (;;) {
            ret = av_read_frame(s->fmt_ctx, s->pkt);
            if (ret < 0) {
                avcodec_send_packet(s->codec_ctx, NULL);
                break;
            }
            if (s->pkt->stream_index == s->video_stream) {
                ret = avcodec_send_packet(s->codec_ctx, s->pkt);
                av_packet_unref(s->pkt);
                if (ret < 0) return ret;
                break;
            }
            av_packet_unref(s->pkt);
        }
    }
}

EMSCRIPTEN_KEEPALIVE
void decoder_close(int handle)
{
    if (handle >= 0 && handle < MAX_SESSIONS && g_dec[handle].active)
        decoder_cleanup(&g_dec[handle]);
}

/* -------------------------------------------------- audio decoder -------- */

typedef struct {
    int               active;
    MemBuf            membuf;
    AVIOContext      *avio_ctx;
    AVFormatContext  *fmt_ctx;
    AVCodecContext   *codec_ctx;
    AVPacket         *pkt;
    AVFrame          *frame;
    struct SwrContext *swr;
    int               audio_stream;
    int               channels;
    int               sample_rate;
} AudioSession;

static AudioSession g_aud[MAX_SESSIONS];

static void audio_cleanup(AudioSession *s)
{
    swr_free(&s->swr);
    av_packet_free(&s->pkt);
    av_frame_free(&s->frame);
    avcodec_free_context(&s->codec_ctx);
    avformat_close_input(&s->fmt_ctx);
    avio_cleanup(&s->avio_ctx);
    av_free(s->membuf.data);
    memset(s, 0, sizeof(*s));
}

static int audio_open_internal(const uint8_t *data, int size, const char *fmt_name)
{
    int slot = -1;
    for (int i = 0; i < MAX_SESSIONS; i++)
        if (!g_aud[i].active) { slot = i; break; }
    if (slot < 0) return AVERROR(ENOMEM);

    AudioSession *s = &g_aud[slot];
    memset(s, 0, sizeof(*s));

    s->membuf.data = av_malloc(size);
    if (!s->membuf.data) return AVERROR(ENOMEM);
    memcpy(s->membuf.data, data, size);
    s->membuf.size = size;

    s->avio_ctx = membuf_avio_alloc(&s->membuf);
    if (!s->avio_ctx) { av_free(s->membuf.data); return AVERROR(ENOMEM); }

    s->fmt_ctx = avformat_alloc_context();
    if (!s->fmt_ctx) { audio_cleanup(s); return AVERROR(ENOMEM); }
    s->fmt_ctx->pb = s->avio_ctx;

    const AVInputFormat *forced = fmt_name ? av_find_input_format(fmt_name) : NULL;
    int ret = avformat_open_input(&s->fmt_ctx, NULL, forced, NULL);
    if (ret < 0) { audio_cleanup(s); return ret; }

    ret = avformat_find_stream_info(s->fmt_ctx, NULL);
    if (ret < 0) { audio_cleanup(s); return ret; }

    s->audio_stream = -1;
    for (unsigned i = 0; i < s->fmt_ctx->nb_streams; i++) {
        if (s->fmt_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
            s->audio_stream = (int)i;
            break;
        }
    }
    if (s->audio_stream < 0) { audio_cleanup(s); return AVERROR_STREAM_NOT_FOUND; }

    AVStream *st = s->fmt_ctx->streams[s->audio_stream];
    const AVCodec *codec = avcodec_find_decoder(st->codecpar->codec_id);
    if (!codec) { audio_cleanup(s); return AVERROR_DECODER_NOT_FOUND; }

    s->codec_ctx = avcodec_alloc_context3(codec);
    if (!s->codec_ctx) { audio_cleanup(s); return AVERROR(ENOMEM); }

    ret = avcodec_parameters_to_context(s->codec_ctx, st->codecpar);
    if (ret < 0) { audio_cleanup(s); return ret; }

    ret = avcodec_open2(s->codec_ctx, codec, NULL);
    if (ret < 0) { audio_cleanup(s); return ret; }

    s->channels    = s->codec_ctx->ch_layout.nb_channels;
    s->sample_rate = s->codec_ctx->sample_rate;

    /* Set up SWR: convert any audio format → f32 interleaved, same rate/channels */
    AVChannelLayout out_layout = AV_CHANNEL_LAYOUT_STEREO;
    if (s->channels == 1)
        out_layout = (AVChannelLayout)AV_CHANNEL_LAYOUT_MONO;

    ret = swr_alloc_set_opts2(&s->swr,
        &out_layout,           AV_SAMPLE_FMT_FLT, s->sample_rate,
        &s->codec_ctx->ch_layout, s->codec_ctx->sample_fmt, s->sample_rate,
        0, NULL);
    if (ret < 0) { audio_cleanup(s); return ret; }
    ret = swr_init(s->swr);
    if (ret < 0) { audio_cleanup(s); return ret; }

    s->pkt   = av_packet_alloc();
    s->frame = av_frame_alloc();
    if (!s->pkt || !s->frame) { audio_cleanup(s); return AVERROR(ENOMEM); }

    s->active = 1;
    return slot;
}

EMSCRIPTEN_KEEPALIVE
int audio_open(const uint8_t *data, int size)
{
    return audio_open_internal(data, size, NULL);
}

EMSCRIPTEN_KEEPALIVE
int audio_open_format(const uint8_t *data, int size, const char *fmt_name)
{
    return audio_open_internal(data, size, fmt_name);
}

EMSCRIPTEN_KEEPALIVE int audio_channels(int h)    { return (h>=0&&h<MAX_SESSIONS&&g_aud[h].active)?g_aud[h].channels   :-1; }
EMSCRIPTEN_KEEPALIVE int audio_sample_rate(int h) { return (h>=0&&h<MAX_SESSIONS&&g_aud[h].active)?g_aud[h].sample_rate:-1; }

/*
 * Decode the next audio frame into dst_f32 (interleaved f32le).
 * Returns the number of float values written (samples * channels),
 * 1 at EOF, or a negative AVERROR code on failure.
 * max_floats is the capacity of dst_f32 in floats.
 */
EMSCRIPTEN_KEEPALIVE
int audio_next_samples(int handle, float *dst_f32, int max_floats)
{
    if (handle < 0 || handle >= MAX_SESSIONS || !g_aud[handle].active)
        return AVERROR(EINVAL);
    AudioSession *s = &g_aud[handle];

    for (;;) {
        int ret = avcodec_receive_frame(s->codec_ctx, s->frame);
        if (ret == 0) {
            int max_samples = max_floats / s->channels;
            uint8_t *out_planes[1] = { (uint8_t *)dst_f32 };
            int converted = swr_convert(s->swr,
                out_planes, max_samples,
                (const uint8_t **)s->frame->data, s->frame->nb_samples);
            av_frame_unref(s->frame);
            if (converted < 0) return converted;
            return converted * s->channels;
        }
        if (ret != AVERROR(EAGAIN)) return ret == AVERROR_EOF ? 1 : ret;

        for (;;) {
            ret = av_read_frame(s->fmt_ctx, s->pkt);
            if (ret < 0) {
                avcodec_send_packet(s->codec_ctx, NULL);
                break;
            }
            if (s->pkt->stream_index == s->audio_stream) {
                ret = avcodec_send_packet(s->codec_ctx, s->pkt);
                av_packet_unref(s->pkt);
                if (ret < 0) return ret;
                break;
            }
            av_packet_unref(s->pkt);
        }
    }
}

EMSCRIPTEN_KEEPALIVE
void audio_close(int handle)
{
    if (handle >= 0 && handle < MAX_SESSIONS && g_aud[handle].active)
        audio_cleanup(&g_aud[handle]);
}

/* -------------------------------------------------- probe ---------------- */

typedef struct {
    int              active;
    MemBuf           membuf;
    AVIOContext     *avio_ctx;
    AVFormatContext *fmt_ctx;
} ProbeSession;

static ProbeSession g_probe[MAX_SESSIONS];

static void probe_cleanup(ProbeSession *s)
{
    avformat_close_input(&s->fmt_ctx);
    avio_cleanup(&s->avio_ctx);
    av_free(s->membuf.data);
    memset(s, 0, sizeof(*s));
}

EMSCRIPTEN_KEEPALIVE
int probe_open(const uint8_t *data, int size)
{
    int slot = -1;
    for (int i = 0; i < MAX_SESSIONS; i++)
        if (!g_probe[i].active) { slot = i; break; }
    if (slot < 0) return AVERROR(ENOMEM);

    ProbeSession *s = &g_probe[slot];
    memset(s, 0, sizeof(*s));

    s->membuf.data = av_malloc(size);
    if (!s->membuf.data) return AVERROR(ENOMEM);
    memcpy(s->membuf.data, data, size);
    s->membuf.size = size;

    s->avio_ctx = membuf_avio_alloc(&s->membuf);
    if (!s->avio_ctx) { av_free(s->membuf.data); return AVERROR(ENOMEM); }

    s->fmt_ctx = avformat_alloc_context();
    if (!s->fmt_ctx) { probe_cleanup(s); return AVERROR(ENOMEM); }
    s->fmt_ctx->pb = s->avio_ctx;

    int ret = avformat_open_input(&s->fmt_ctx, NULL, NULL, NULL);
    if (ret < 0) { probe_cleanup(s); return ret; }

    ret = avformat_find_stream_info(s->fmt_ctx, NULL);
    if (ret < 0) { probe_cleanup(s); return ret; }

    s->active = 1;
    return slot;
}

EMSCRIPTEN_KEEPALIVE
const char *probe_format_name(int handle)
{
    if (handle < 0 || handle >= MAX_SESSIONS || !g_probe[handle].active) return NULL;
    return g_probe[handle].fmt_ctx->iformat->name;
}

EMSCRIPTEN_KEEPALIVE
int probe_duration_ms(int handle)
{
    if (handle < 0 || handle >= MAX_SESSIONS || !g_probe[handle].active) return -1;
    int64_t d = g_probe[handle].fmt_ctx->duration;
    return (d == AV_NOPTS_VALUE) ? -1 : (int)(d / 1000);
}

EMSCRIPTEN_KEEPALIVE
int probe_stream_count(int handle)
{
    if (handle < 0 || handle >= MAX_SESSIONS || !g_probe[handle].active) return -1;
    return (int)g_probe[handle].fmt_ctx->nb_streams;
}

EMSCRIPTEN_KEEPALIVE
int probe_stream_type(int handle, int idx)
{
    if (handle < 0 || handle >= MAX_SESSIONS || !g_probe[handle].active) return -1;
    AVFormatContext *fc = g_probe[handle].fmt_ctx;
    if (idx < 0 || (unsigned)idx >= fc->nb_streams) return -1;
    return (int)fc->streams[idx]->codecpar->codec_type;
}

static AVStream *probe_find_stream(int handle, enum AVMediaType type)
{
    if (handle < 0 || handle >= MAX_SESSIONS || !g_probe[handle].active) return NULL;
    AVFormatContext *fc = g_probe[handle].fmt_ctx;
    for (unsigned i = 0; i < fc->nb_streams; i++)
        if (fc->streams[i]->codecpar->codec_type == type)
            return fc->streams[i];
    return NULL;
}

EMSCRIPTEN_KEEPALIVE int probe_width(int h)       { AVStream *s=probe_find_stream(h,AVMEDIA_TYPE_VIDEO); return s?s->codecpar->width :-1; }
EMSCRIPTEN_KEEPALIVE int probe_height(int h)      { AVStream *s=probe_find_stream(h,AVMEDIA_TYPE_VIDEO); return s?s->codecpar->height:-1; }
EMSCRIPTEN_KEEPALIVE int probe_fps_num(int h)     { AVStream *s=probe_find_stream(h,AVMEDIA_TYPE_VIDEO); return s&&s->avg_frame_rate.den?s->avg_frame_rate.num:-1; }
EMSCRIPTEN_KEEPALIVE int probe_fps_den(int h)     { AVStream *s=probe_find_stream(h,AVMEDIA_TYPE_VIDEO); return s&&s->avg_frame_rate.den?s->avg_frame_rate.den:-1; }
EMSCRIPTEN_KEEPALIVE int probe_sample_rate(int h) { AVStream *s=probe_find_stream(h,AVMEDIA_TYPE_AUDIO); return s?s->codecpar->sample_rate:-1; }
EMSCRIPTEN_KEEPALIVE int probe_channels(int h)    { AVStream *s=probe_find_stream(h,AVMEDIA_TYPE_AUDIO); return s?s->codecpar->ch_layout.nb_channels:-1; }
EMSCRIPTEN_KEEPALIVE int probe_bitrate(int h)     { return (h>=0&&h<MAX_SESSIONS&&g_probe[h].active)?(int)(g_probe[h].fmt_ctx->bit_rate/1000):-1; }

EMSCRIPTEN_KEEPALIVE
void probe_close(int handle)
{
    if (handle >= 0 && handle < MAX_SESSIONS && g_probe[handle].active)
        probe_cleanup(&g_probe[handle]);
}

/* -------------------------------------------------- encoder -------------- */

/* Growable + seekable write buffer for muxer output. */
typedef struct {
    uint8_t *data;
    size_t   size;
    size_t   cap;
    int64_t  pos;
} WriteBuf;

static int writebuf_write(void *opaque, const uint8_t *buf, int size)
{
    WriteBuf *w = opaque;
    size_t end = (size_t)w->pos + size;
    if (end > w->cap) {
        size_t newcap = w->cap ? w->cap * 2 : 131072;
        while (newcap < end) newcap *= 2;
        uint8_t *p = av_realloc(w->data, newcap);
        if (!p) return AVERROR(ENOMEM);
        w->data = p;
        w->cap  = newcap;
    }
    memcpy(w->data + w->pos, buf, size);
    w->pos += size;
    if ((size_t)w->pos > w->size) w->size = (size_t)w->pos;
    return size;
}

static int64_t writebuf_seek(void *opaque, int64_t offset, int whence)
{
    WriteBuf *w = opaque;
    int64_t p;
    if      (whence == SEEK_SET) p = offset;
    else if (whence == SEEK_CUR) p = w->pos + offset;
    else if (whence == SEEK_END) p = (int64_t)w->size + offset;
    else if (whence == AVSEEK_SIZE) return (int64_t)w->size;
    else return -1;
    if (p < 0) return -1;
    w->pos = p;
    return p;
}

#define MAX_ENCODER_SESSIONS 4

typedef struct {
    int               active;
    WriteBuf          wbuf;
    AVIOContext      *avio_ctx;
    AVFormatContext  *fmt_ctx;
    AVCodecContext   *codec_ctx;
    AVStream         *stream;
    AVPacket         *pkt;
    AVFrame          *frame;        /* encoder pixel format frame */
    struct SwsContext *sws;         /* RGBA → encoder pix_fmt */
    int               width, height;
    int64_t           pts;
} EncoderSession;

static EncoderSession g_enc[MAX_ENCODER_SESSIONS];

static void encoder_cleanup(EncoderSession *s)
{
    sws_freeContext(s->sws);
    av_packet_free(&s->pkt);
    av_frame_free(&s->frame);
    avcodec_free_context(&s->codec_ctx);
    if (s->fmt_ctx) avformat_free_context(s->fmt_ctx);
    avio_cleanup(&s->avio_ctx);
    av_free(s->wbuf.data);
    memset(s, 0, sizeof(*s));
}

/*
 * Open an encoder session.
 *
 * fmt_name   — container format (e.g., "mp4", "webm", "image2")
 * codec_name — encoder name (e.g., "mjpeg", "png", "aac")
 * width, height — frame dimensions (0 for audio-only)
 * fps_num, fps_den — frame rate (e.g., 30, 1)
 * bitrate    — target bitrate in bits/s (0 for lossless/default)
 *
 * Returns session handle (>= 0) or negative AVERROR.
 */
EMSCRIPTEN_KEEPALIVE
int encoder_open(const char *fmt_name, const char *codec_name,
                 int width, int height, int fps_num, int fps_den, int bitrate)
{
    int slot = -1;
    for (int i = 0; i < MAX_ENCODER_SESSIONS; i++)
        if (!g_enc[i].active) { slot = i; break; }
    if (slot < 0) return AVERROR(ENOMEM);

    EncoderSession *s = &g_enc[slot];
    memset(s, 0, sizeof(*s));

    /* AVIO for output */
    uint8_t *iobuf = av_malloc(65536);
    if (!iobuf) return AVERROR(ENOMEM);
    s->avio_ctx = avio_alloc_context(iobuf, 65536, 1,
                                     &s->wbuf, NULL, writebuf_write, writebuf_seek);
    if (!s->avio_ctx) { av_free(iobuf); return AVERROR(ENOMEM); }

    int ret = avformat_alloc_output_context2(&s->fmt_ctx, NULL, fmt_name, NULL);
    if (ret < 0) { encoder_cleanup(s); return ret; }
    s->fmt_ctx->pb    = s->avio_ctx;
    s->fmt_ctx->flags |= AVFMT_FLAG_CUSTOM_IO;

    const AVCodec *codec = avcodec_find_encoder_by_name(codec_name);
    if (!codec) { encoder_cleanup(s); return AVERROR_ENCODER_NOT_FOUND; }

    s->stream = avformat_new_stream(s->fmt_ctx, NULL);
    if (!s->stream) { encoder_cleanup(s); return AVERROR(ENOMEM); }

    s->codec_ctx = avcodec_alloc_context3(codec);
    if (!s->codec_ctx) { encoder_cleanup(s); return AVERROR(ENOMEM); }

    /* Use the first supported pixel format */
    const enum AVPixelFormat *supported_fmts = NULL;
    avcodec_get_supported_config(NULL, codec, AV_CODEC_CONFIG_PIX_FORMAT, 0,
                                 (const void **)&supported_fmts, NULL);
    enum AVPixelFormat pix_fmt = (supported_fmts && supported_fmts[0] != AV_PIX_FMT_NONE)
                                 ? supported_fmts[0] : AV_PIX_FMT_YUV420P;

    s->codec_ctx->width     = width;
    s->codec_ctx->height    = height;
    s->codec_ctx->pix_fmt   = pix_fmt;
    s->codec_ctx->time_base = (AVRational){ fps_den, fps_num };
    s->codec_ctx->framerate = (AVRational){ fps_num, fps_den };
    if (bitrate > 0) s->codec_ctx->bit_rate = bitrate;

    if (s->fmt_ctx->oformat->flags & AVFMT_GLOBALHEADER)
        s->codec_ctx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

    ret = avcodec_open2(s->codec_ctx, codec, NULL);
    if (ret < 0) { encoder_cleanup(s); return ret; }

    ret = avcodec_parameters_from_context(s->stream->codecpar, s->codec_ctx);
    if (ret < 0) { encoder_cleanup(s); return ret; }
    s->stream->time_base = s->codec_ctx->time_base;

    /* SWS: RGBA → encoder pixel format */
    s->sws = sws_getContext(width, height, AV_PIX_FMT_RGBA,
                            width, height, pix_fmt,
                            SWS_BILINEAR, NULL, NULL, NULL);
    if (!s->sws) { encoder_cleanup(s); return AVERROR(ENOMEM); }

    /* Pre-alloc encoder frame */
    s->frame = av_frame_alloc();
    if (!s->frame) { encoder_cleanup(s); return AVERROR(ENOMEM); }
    s->frame->format = pix_fmt;
    s->frame->width  = width;
    s->frame->height = height;
    ret = av_frame_get_buffer(s->frame, 0);
    if (ret < 0) { encoder_cleanup(s); return ret; }

    s->pkt = av_packet_alloc();
    if (!s->pkt) { encoder_cleanup(s); return AVERROR(ENOMEM); }

    ret = avformat_write_header(s->fmt_ctx, NULL);
    if (ret < 0) { encoder_cleanup(s); return ret; }

    s->width  = width;
    s->height = height;
    s->active = 1;
    return slot;
}

/*
 * Push one RGBA frame into the encoder.
 * pts_ms is the presentation timestamp in milliseconds.
 * Returns 0 on success, negative AVERROR on failure.
 */
EMSCRIPTEN_KEEPALIVE
int encoder_push_rgba(int handle, const uint8_t *rgba, int w, int h, int64_t pts_ms)
{
    if (handle < 0 || handle >= MAX_ENCODER_SESSIONS || !g_enc[handle].active)
        return AVERROR(EINVAL);
    EncoderSession *s = &g_enc[handle];

    const uint8_t *src_slices[1] = { rgba };
    int src_stride[1] = { w * 4 };
    sws_scale(s->sws, src_slices, src_stride, 0, h,
              s->frame->data, s->frame->linesize);

    s->frame->pts = av_rescale_q(pts_ms, (AVRational){1, 1000}, s->codec_ctx->time_base);

    int ret = avcodec_send_frame(s->codec_ctx, s->frame);
    if (ret < 0) return ret;

    while (ret >= 0) {
        ret = avcodec_receive_packet(s->codec_ctx, s->pkt);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) break;
        if (ret < 0) return ret;
        av_packet_rescale_ts(s->pkt, s->codec_ctx->time_base, s->stream->time_base);
        s->pkt->stream_index = s->stream->index;
        ret = av_write_frame(s->fmt_ctx, s->pkt);
        av_packet_unref(s->pkt);
        if (ret < 0) return ret;
    }
    return 0;
}

/*
 * Flush the encoder and write the container trailer.
 * After this call, use encoder_output_ptr/size to read the output bytes.
 * Returns 0 on success, negative AVERROR on failure.
 */
EMSCRIPTEN_KEEPALIVE
int encoder_finish(int handle)
{
    if (handle < 0 || handle >= MAX_ENCODER_SESSIONS || !g_enc[handle].active)
        return AVERROR(EINVAL);
    EncoderSession *s = &g_enc[handle];

    int ret = avcodec_send_frame(s->codec_ctx, NULL);
    while (ret >= 0) {
        ret = avcodec_receive_packet(s->codec_ctx, s->pkt);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) break;
        if (ret < 0) return ret;
        av_packet_rescale_ts(s->pkt, s->codec_ctx->time_base, s->stream->time_base);
        s->pkt->stream_index = s->stream->index;
        ret = av_write_frame(s->fmt_ctx, s->pkt);
        av_packet_unref(s->pkt);
        if (ret < 0) return ret;
    }
    return av_write_trailer(s->fmt_ctx);
}

EMSCRIPTEN_KEEPALIVE uint8_t *encoder_output_ptr(int h)  { return (h>=0&&h<MAX_ENCODER_SESSIONS&&g_enc[h].active)?g_enc[h].wbuf.data:NULL; }
EMSCRIPTEN_KEEPALIVE int      encoder_output_size(int h) { return (h>=0&&h<MAX_ENCODER_SESSIONS&&g_enc[h].active)?(int)g_enc[h].wbuf.size:-1; }

EMSCRIPTEN_KEEPALIVE
void encoder_close(int handle)
{
    if (handle >= 0 && handle < MAX_ENCODER_SESSIONS && g_enc[handle].active)
        encoder_cleanup(&g_enc[handle]);
}

/* ------------------------------------------------------------ benchmarks */

EMSCRIPTEN_KEEPALIVE
double bench_scale_webgpu(int src_w, int src_h, int dst_w, int dst_h, int n)
{
#ifdef CONFIG_WEBGPU
    char fg[64];
    snprintf(fg, sizeof(fg), "scale_webgpu=%d:%d", dst_w, dst_h);

    uint8_t *src = (uint8_t *)av_malloc(src_w * src_h * 4);
    uint8_t *dst = (uint8_t *)av_malloc(dst_w * dst_h * 4);
    if (!src || !dst) { av_free(src); av_free(dst); return -1.0; }
    memset(src, 128, src_w * src_h * 4);

    double t0 = emscripten_get_now();
    for (int i = 0; i < n; i++)
        pipeline_run_rgba_gpu(src, src_w, src_h, dst, dst_w, dst_h, fg);
    double elapsed = (emscripten_get_now() - t0) / n;

    av_free(src); av_free(dst);
    return elapsed;
#else
    return -1.0;
#endif
}

EMSCRIPTEN_KEEPALIVE
double bench_scale_cpu(int src_w, int src_h, int dst_w, int dst_h, int n)
{
    char fg[64];
    snprintf(fg, sizeof(fg), "scale=%d:%d", dst_w, dst_h);

    uint8_t *src = (uint8_t *)av_malloc(src_w * src_h * 4);
    uint8_t *dst = (uint8_t *)av_malloc(dst_w * dst_h * 4);
    if (!src || !dst) { av_free(src); av_free(dst); return -1.0; }
    memset(src, 128, src_w * src_h * 4);

    double t0 = emscripten_get_now();
    for (int i = 0; i < n; i++)
        pipeline_run_rgba(src, src_w, src_h, dst, dst_w, dst_h, fg);
    double elapsed = (emscripten_get_now() - t0) / n;

    av_free(src); av_free(dst);
    return elapsed;
}
