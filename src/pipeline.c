/*
 * Generic FFmpeg filter pipeline for WASM.
 *
 * New GPU filters slot in via the filtergraph string — no changes to this
 * file needed. Compile with build-cpu.sh or build-webgpu.sh.
 */

#include <string.h>
#include <emscripten.h>
#include <libavutil/avutil.h>
#include <libavutil/frame.h>
#include <libavutil/imgutils.h>
#include <libavutil/log.h>
#include <libavutil/pixfmt.h>
#include <libavutil/hwcontext.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>

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

/* -------------------------------------------------- avformat decoder ---- */

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

#define MAX_SESSIONS   8
#define AVIO_BUF_SIZE  65536

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

static DecodeSession g_sessions[MAX_SESSIONS];

EMSCRIPTEN_KEEPALIVE
int decoder_open(const uint8_t *data, int size)
{
    int slot = -1;
    for (int i = 0; i < MAX_SESSIONS; i++)
        if (!g_sessions[i].active) { slot = i; break; }
    if (slot < 0) return AVERROR(ENOMEM);

    DecodeSession *s = &g_sessions[slot];
    memset(s, 0, sizeof(*s));

    s->membuf.data = av_malloc(size);
    if (!s->membuf.data) return AVERROR(ENOMEM);
    memcpy(s->membuf.data, data, size);
    s->membuf.size = size;

    uint8_t *avio_buf = av_malloc(AVIO_BUF_SIZE);
    if (!avio_buf) { av_free(s->membuf.data); return AVERROR(ENOMEM); }

    s->avio_ctx = avio_alloc_context(avio_buf, AVIO_BUF_SIZE, 0,
                                     &s->membuf, mem_read, NULL, mem_seek);
    if (!s->avio_ctx) { av_free(avio_buf); av_free(s->membuf.data); return AVERROR(ENOMEM); }

    s->fmt_ctx = avformat_alloc_context();
    if (!s->fmt_ctx) {
        av_freep(&s->avio_ctx->buffer);
        avio_context_free(&s->avio_ctx);
        av_free(s->membuf.data);
        return AVERROR(ENOMEM);
    }
    s->fmt_ctx->pb = s->avio_ctx;

    int ret = avformat_open_input(&s->fmt_ctx, NULL, NULL, NULL);
    if (ret < 0) goto fail;

    ret = avformat_find_stream_info(s->fmt_ctx, NULL);
    if (ret < 0) goto fail;

    s->video_stream = -1;
    for (unsigned i = 0; i < s->fmt_ctx->nb_streams; i++) {
        if (s->fmt_ctx->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
            s->video_stream = (int)i;
            break;
        }
    }
    if (s->video_stream < 0) { ret = AVERROR_STREAM_NOT_FOUND; goto fail; }

    AVStream *st = s->fmt_ctx->streams[s->video_stream];
    const AVCodec *codec = avcodec_find_decoder(st->codecpar->codec_id);
    if (!codec) { ret = AVERROR_DECODER_NOT_FOUND; goto fail; }

    s->codec_ctx = avcodec_alloc_context3(codec);
    if (!s->codec_ctx) { ret = AVERROR(ENOMEM); goto fail; }

    ret = avcodec_parameters_to_context(s->codec_ctx, st->codecpar);
    if (ret < 0) goto fail;

    ret = avcodec_open2(s->codec_ctx, codec, NULL);
    if (ret < 0) goto fail;

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
    if (!s->pkt || !s->frame) { ret = AVERROR(ENOMEM); goto fail; }

    s->active = 1;
    return slot;

fail:
    avformat_close_input(&s->fmt_ctx);
    if (s->avio_ctx) { av_freep(&s->avio_ctx->buffer); avio_context_free(&s->avio_ctx); }
    av_free(s->membuf.data);
    av_packet_free(&s->pkt);
    av_frame_free(&s->frame);
    avcodec_free_context(&s->codec_ctx);
    memset(s, 0, sizeof(*s));
    return ret;
}

EMSCRIPTEN_KEEPALIVE int decoder_width(int h)   { return (h>=0&&h<MAX_SESSIONS&&g_sessions[h].active)?g_sessions[h].width  :-1; }
EMSCRIPTEN_KEEPALIVE int decoder_height(int h)  { return (h>=0&&h<MAX_SESSIONS&&g_sessions[h].active)?g_sessions[h].height :-1; }
EMSCRIPTEN_KEEPALIVE int decoder_fps_num(int h) { return (h>=0&&h<MAX_SESSIONS&&g_sessions[h].active)?g_sessions[h].fps_num:-1; }
EMSCRIPTEN_KEEPALIVE int decoder_fps_den(int h) { return (h>=0&&h<MAX_SESSIONS&&g_sessions[h].active)?g_sessions[h].fps_den:-1; }

EMSCRIPTEN_KEEPALIVE
int decoder_next_frame(int handle, uint8_t *dst_rgba, int dst_w, int dst_h)
{
    if (handle < 0 || handle >= MAX_SESSIONS || !g_sessions[handle].active)
        return AVERROR(EINVAL);
    DecodeSession *s = &g_sessions[handle];

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

EMSCRIPTEN_KEEPALIVE
void decoder_close(int handle)
{
    if (handle < 0 || handle >= MAX_SESSIONS || !g_sessions[handle].active) return;
    DecodeSession *s = &g_sessions[handle];
    sws_freeContext(s->sws);
    av_packet_free(&s->pkt);
    av_frame_free(&s->frame);
    avcodec_free_context(&s->codec_ctx);
    avformat_close_input(&s->fmt_ctx);
    if (s->avio_ctx) { av_freep(&s->avio_ctx->buffer); avio_context_free(&s->avio_ctx); }
    av_free(s->membuf.data);
    memset(s, 0, sizeof(*s));
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
