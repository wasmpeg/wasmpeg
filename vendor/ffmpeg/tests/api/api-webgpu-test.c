/*
 * This file is part of FFmpeg.
 *
 * FFmpeg is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * FFmpeg is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with FFmpeg; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

#include <stdio.h>
#include <string.h>
#include <emscripten.h>

#include "libavutil/hwcontext.h"
#include "libavutil/hwcontext_webgpu.h"
#include "libavutil/frame.h"
#include "libavutil/log.h"
#include "libavutil/pixfmt.h"
#include "libavfilter/avfilter.h"
#include "libavfilter/buffersink.h"
#include "libavfilter/buffersrc.h"

static int make_webgpu_device(AVBufferRef **out)
{
    return av_hwdevice_ctx_create(out, AV_HWDEVICE_TYPE_WEBGPU, NULL, NULL, 0);
}

static int make_webgpu_frames(AVBufferRef *device_ref, int w, int h,
                               AVBufferRef **out)
{
    AVBufferRef *ref = av_hwframe_ctx_alloc(device_ref);
    if (!ref) return AVERROR(ENOMEM);
    AVHWFramesContext *fc = (AVHWFramesContext *)ref->data;
    fc->format            = AV_PIX_FMT_WEBGPU;
    fc->sw_format         = AV_PIX_FMT_RGBA;
    fc->width             = w;
    fc->height            = h;
    fc->initial_pool_size = 4;
    int ret = av_hwframe_ctx_init(ref);
    if (ret < 0) { av_buffer_unref(&ref); return ret; }
    *out = ref;
    return 0;
}

static AVFrame *make_gradient_hw_frame(AVBufferRef *frames_ref, int w, int h)
{
    AVFrame *sw = av_frame_alloc();
    if (!sw) return NULL;
    sw->format = AV_PIX_FMT_RGBA;
    sw->width  = w;
    sw->height = h;
    if (av_frame_get_buffer(sw, 0) < 0) { av_frame_free(&sw); return NULL; }
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++) {
            uint8_t *p = sw->data[0] + y * sw->linesize[0] + x * 4;
            p[0] = (uint8_t)(x * 255 / (w - 1));
            p[1] = (uint8_t)(y * 255 / (h - 1));
            p[2] = 128; p[3] = 255;
        }
    AVFrame *hw = av_frame_alloc();
    if (!hw || av_hwframe_get_buffer(frames_ref, hw, 0) < 0 ||
        av_hwframe_transfer_data(hw, sw, 0) < 0) {
        av_frame_free(&sw); av_frame_free(&hw); return NULL;
    }
    av_frame_free(&sw);
    return hw;
}

static int run_scale_webgpu(AVFilterContext **src_out, AVFilterContext **sink_out,
                             AVFilterGraph **graph_out, AVBufferRef *frames_ref,
                             int src_w, int src_h, int dst_w, int dst_h)
{
    const AVFilter *bsrc  = avfilter_get_by_name("buffer");
    const AVFilter *bsink = avfilter_get_by_name("buffersink");
    const AVFilter *scale = avfilter_get_by_name("scale_webgpu");
    if (!scale) return AVERROR_FILTER_NOT_FOUND;

    AVFilterGraph *graph = avfilter_graph_alloc();
    if (!graph) return AVERROR(ENOMEM);

    char src_args[128], scale_args[64];
    snprintf(src_args, sizeof(src_args),
             "video_size=%dx%d:pix_fmt=%d:time_base=1/25:pixel_aspect=1/1",
             src_w, src_h, AV_PIX_FMT_WEBGPU);
    snprintf(scale_args, sizeof(scale_args), "w=%d:h=%d", dst_w, dst_h);

    AVFilterContext *src_ctx = NULL, *scale_ctx = NULL, *sink_ctx = NULL;
    int ret;
    ret = avfilter_graph_create_filter(&src_ctx,   bsrc,  "in",    src_args,   NULL, graph); if (ret < 0) goto fail;
    ((FilterLink *)src_ctx->outputs[0])->hw_frames_ctx = av_buffer_ref(frames_ref);
    ret = avfilter_graph_create_filter(&scale_ctx, scale, "scale", scale_args, NULL, graph); if (ret < 0) goto fail;
    ret = avfilter_graph_create_filter(&sink_ctx,  bsink, "out",   NULL,       NULL, graph); if (ret < 0) goto fail;
    ret = avfilter_link(src_ctx, 0, scale_ctx, 0);  if (ret < 0) goto fail;
    ret = avfilter_link(scale_ctx, 0, sink_ctx, 0); if (ret < 0) goto fail;
    ret = avfilter_graph_config(graph, NULL);        if (ret < 0) goto fail;
    *src_out = src_ctx; *sink_out = sink_ctx; *graph_out = graph;
    return 0;
fail:
    avfilter_graph_free(&graph);
    return ret;
}

static int test_hwcontext_roundtrip(void)
{
    AVBufferRef *device_ref = NULL, *frames_ref = NULL;
    AVFrame *sw = NULL, *hw = NULL, *dl = NULL;
    int ret;

    ret = make_webgpu_device(&device_ref); if (ret < 0) goto end;
    ret = make_webgpu_frames(device_ref, 64, 64, &frames_ref); if (ret < 0) goto end;

    sw = av_frame_alloc();
    sw->format = AV_PIX_FMT_RGBA; sw->width = sw->height = 64;
    av_frame_get_buffer(sw, 0);
    for (int y = 0; y < 64; y++)
        for (int x = 0; x < 64; x++) {
            uint8_t *p = sw->data[0] + y * sw->linesize[0] + x * 4;
            uint8_t v = ((x / 8 + y / 8) % 2) ? 255 : 0;
            p[0] = p[1] = p[2] = v; p[3] = 255;
        }

    hw = av_frame_alloc();
    ret = av_hwframe_get_buffer(frames_ref, hw, 0); if (ret < 0) goto end;
    ret = av_hwframe_transfer_data(hw, sw, 0);      if (ret < 0) goto end;

    dl = av_frame_alloc();
    dl->format = AV_PIX_FMT_RGBA; dl->width = dl->height = 64;
    av_frame_get_buffer(dl, 0);
    ret = av_hwframe_transfer_data(dl, hw, 0); if (ret < 0) goto end;

    for (int y = 0; y < 64 && ret == 0; y++)
        for (int x = 0; x < 64 && ret == 0; x++) {
            uint8_t *a = sw->data[0] + y * sw->linesize[0] + x * 4;
            uint8_t *b = dl->data[0] + y * dl->linesize[0] + x * 4;
            if (a[0] != b[0] || a[1] != b[1] || a[2] != b[2])
                ret = AVERROR_EXTERNAL;
        }
end:
    av_frame_free(&sw); av_frame_free(&hw); av_frame_free(&dl);
    av_buffer_unref(&frames_ref); av_buffer_unref(&device_ref);
    return ret;
}

static int test_scale(int src_w, int src_h, int dst_w, int dst_h)
{
    AVBufferRef     *device_ref = NULL, *frames_ref = NULL;
    AVFrame         *hw = NULL, *scaled = NULL, *dl = NULL;
    AVFilterGraph   *graph    = NULL;
    AVFilterContext *src_ctx  = NULL, *sink_ctx = NULL;
    int ret;

    ret = make_webgpu_device(&device_ref); if (ret < 0) goto end;
    ret = make_webgpu_frames(device_ref, src_w, src_h, &frames_ref); if (ret < 0) goto end;

    hw = make_gradient_hw_frame(frames_ref, src_w, src_h);
    if (!hw) { ret = AVERROR(ENOMEM); goto end; }

    ret = run_scale_webgpu(&src_ctx, &sink_ctx, &graph,
                            frames_ref, src_w, src_h, dst_w, dst_h);
    if (ret < 0) goto end;

    ret = av_buffersrc_add_frame_flags(src_ctx, hw, AV_BUFFERSRC_FLAG_KEEP_REF);
    if (ret < 0) goto end;

    scaled = av_frame_alloc();
    ret = av_buffersink_get_frame(sink_ctx, scaled);
    if (ret < 0) { av_frame_free(&scaled); goto end; }

    if (scaled->width != dst_w || scaled->height != dst_h) {
        av_log(NULL, AV_LOG_ERROR, "scale: got %dx%d want %dx%d\n",
               scaled->width, scaled->height, dst_w, dst_h);
        ret = AVERROR_EXTERNAL;
        av_frame_free(&scaled);
        goto end;
    }

    dl = av_frame_alloc();
    dl->format = AV_PIX_FMT_RGBA; dl->width = dst_w; dl->height = dst_h;
    av_frame_get_buffer(dl, 0);
    ret = av_hwframe_transfer_data(dl, scaled, 0);
    av_frame_free(&scaled);

end:
    avfilter_graph_free(&graph);
    av_frame_free(&hw); av_frame_free(&dl);
    av_buffer_unref(&frames_ref); av_buffer_unref(&device_ref);
    return ret;
}

typedef struct { const char *name; int (*fn)(void); } TestCase;

#define SCALE_TEST(name, sw, sh, dw, dh) \
    static int test_scale_##name(void) { return test_scale(sw, sh, dw, dh); }

SCALE_TEST(upscale,      64,  64, 128, 128)
SCALE_TEST(downscale,   128, 128,  32,  32)
SCALE_TEST(passthrough,  64,  64,  64,  64)
SCALE_TEST(asymmetric,  320, 240, 160,  90)

static const TestCase tests[] = {
    { "hwcontext::roundtrip",      test_hwcontext_roundtrip },
    { "scale_webgpu::upscale",     test_scale_upscale       },
    { "scale_webgpu::downscale",   test_scale_downscale     },
    { "scale_webgpu::passthrough", test_scale_passthrough   },
    { "scale_webgpu::asymmetric",  test_scale_asymmetric    },
};

int main(void)
{
    int n = FF_ARRAY_ELEMS(tests);
    int passed = 0, failed = 0;

    av_log_set_level(AV_LOG_WARNING);
    printf("running %d tests\n\n", n);

    for (int i = 0; i < n; i++) {
        double t0  = emscripten_get_now();
        int    ret = tests[i].fn();
        int    ms  = (int)(emscripten_get_now() - t0);

        if (ret == 0) {
            printf("PASS %s %d\n", tests[i].name, ms);
            passed++;
        } else {
            printf("FAIL %s %d ret=%d\n", tests[i].name, ms, ret);
            failed++;
        }
        fflush(stdout);
    }

    printf("\n%d passed; %d failed\n", passed, failed);
    return failed > 0 ? 1 : 0;
}
