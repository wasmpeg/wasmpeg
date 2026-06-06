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
