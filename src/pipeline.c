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
