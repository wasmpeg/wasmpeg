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

#include <string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#include <webgpu/webgpu.h>

#include "hwcontext.h"
#include "hwcontext_internal.h"
#include "hwcontext_webgpu.h"
#include "mem.h"
#include "log.h"
#include "pixdesc.h"

#define DEFAULT_TEXTURE_USAGE \
    (WGPUTextureUsage_CopyDst | WGPUTextureUsage_CopySrc | \
     WGPUTextureUsage_StorageBinding | WGPUTextureUsage_TextureBinding)

typedef struct WebGPUDevicePriv {
    AVWebGPUDeviceContext p;
    int async_done;
} WebGPUDevicePriv;

typedef struct WebGPUFramesPriv {
    AVWebGPUFramesContext p;
} WebGPUFramesPriv;

typedef struct {
    int done;
    int error;
} MapContext;

/* Yield until a WebGPU callback sets *flag.  Emscripten requires
 * emscripten_sleep() to hand control back to the JS event loop;
 * native builds use wgpuInstanceProcessEvents() instead. */
static av_always_inline void webgpu_await(WGPUInstance instance, volatile int *flag)
{
#ifdef __EMSCRIPTEN__
    while (!*flag)
        emscripten_sleep(1);
#else
    while (!*flag)
        wgpuInstanceProcessEvents(instance);
#endif
}

static void on_adapter_ready(WGPURequestAdapterStatus status, WGPUAdapter adapter,
                              WGPUStringView message, void *userdata1, void *userdata2)
{
    WebGPUDevicePriv *priv = userdata1;
    if (status == WGPURequestAdapterStatus_Success)
        priv->p.adapter = adapter;
    priv->async_done = 1;
}

static void on_device_ready(WGPURequestDeviceStatus status, WGPUDevice device,
                             WGPUStringView message, void *userdata1, void *userdata2)
{
    WebGPUDevicePriv *priv = userdata1;
    if (status == WGPURequestDeviceStatus_Success) {
        priv->p.device = device;
        priv->p.queue  = wgpuDeviceGetQueue(device);
    }
    priv->async_done = 1;
}

static void on_buffer_mapped(WGPUMapAsyncStatus status, WGPUStringView message,
                              void *userdata1, void *userdata2)
{
    MapContext *ctx = userdata1;
    ctx->done  = 1;
    if (status != WGPUMapAsyncStatus_Success)
        ctx->error = 1;
}

static int webgpu_device_create(AVHWDeviceContext *ctx, const char *device,
                                AVDictionary *opts, int flags)
{
    WebGPUDevicePriv *priv = ctx->hwctx;
    WGPUInstanceDescriptor desc = { 0 };

    priv->p.instance = wgpuCreateInstance(&desc);
    if (!priv->p.instance) {
        av_log(ctx, AV_LOG_ERROR, "Could not initialize WebGPU instance.\n");
        return AVERROR_UNKNOWN;
    }

    WGPURequestAdapterOptions adapter_opts = { 0 };
    WGPURequestAdapterCallbackInfo adapter_cb = {
        .callback  = on_adapter_ready,
        .mode      = WGPUCallbackMode_AllowSpontaneous,
        .userdata1 = priv,
    };

    priv->async_done = 0;
    wgpuInstanceRequestAdapter(priv->p.instance, &adapter_opts, adapter_cb);
    webgpu_await(priv->p.instance, &priv->async_done);

    if (!priv->p.adapter) {
        av_log(ctx, AV_LOG_ERROR, "Failed to get WebGPU adapter.\n");
        return AVERROR_UNKNOWN;
    }

    WGPUDeviceDescriptor dev_desc = { 0 };
    WGPURequestDeviceCallbackInfo device_cb = {
        .callback  = on_device_ready,
        .mode      = WGPUCallbackMode_AllowSpontaneous,
        .userdata1 = priv,
    };

    priv->async_done = 0;
    wgpuAdapterRequestDevice(priv->p.adapter, &dev_desc, device_cb);
    webgpu_await(priv->p.instance, &priv->async_done);

    if (!priv->p.device) {
        av_log(ctx, AV_LOG_ERROR, "Failed to get WebGPU device.\n");
        return AVERROR_UNKNOWN;
    }

    av_log(ctx, AV_LOG_VERBOSE, "WebGPU device created successfully.\n");
    return 0;
}

static void webgpu_device_uninit(AVHWDeviceContext *ctx)
{
    WebGPUDevicePriv *priv = ctx->hwctx;
    if (priv->p.queue)    wgpuQueueRelease(priv->p.queue);
    if (priv->p.device)   wgpuDeviceRelease(priv->p.device);
    if (priv->p.adapter)  wgpuAdapterRelease(priv->p.adapter);
    if (priv->p.instance) wgpuInstanceRelease(priv->p.instance);
}

static int webgpu_frames_get_constraints(AVHWDeviceContext *ctx,
                                         const void *hwconfig,
                                         AVHWFramesConstraints *constraints)
{
    constraints->valid_sw_formats = av_malloc_array(2, sizeof(*constraints->valid_sw_formats));
    if (!constraints->valid_sw_formats)
        return AVERROR(ENOMEM);
    constraints->valid_sw_formats[0] = AV_PIX_FMT_RGBA;
    constraints->valid_sw_formats[1] = AV_PIX_FMT_NONE;

    constraints->valid_hw_formats = av_malloc_array(2, sizeof(*constraints->valid_hw_formats));
    if (!constraints->valid_hw_formats)
        return AVERROR(ENOMEM);
    constraints->valid_hw_formats[0] = AV_PIX_FMT_WEBGPU;
    constraints->valid_hw_formats[1] = AV_PIX_FMT_NONE;

    return 0;
}

static int webgpu_frames_init(AVHWFramesContext *hwfc)
{
    WebGPUFramesPriv *fpriv = hwfc->hwctx;

    if (hwfc->sw_format != AV_PIX_FMT_RGBA) {
        av_log(hwfc, AV_LOG_ERROR, "Only AV_PIX_FMT_RGBA is supported as sw_format.\n");
        return AVERROR(EINVAL);
    }

    if (!fpriv->p.usage)
        fpriv->p.usage = DEFAULT_TEXTURE_USAGE;
    if (!fpriv->p.format)
        fpriv->p.format = WGPUTextureFormat_RGBA8Unorm;

    return 0;
}

static void webgpu_frame_free(void *opaque, uint8_t *data)
{
    AVWebGPUFrame *f = (AVWebGPUFrame *)data;
    if (f->view)    wgpuTextureViewRelease(f->view);
    if (f->texture) wgpuTextureRelease(f->texture);
    av_free(f);
}

static int webgpu_get_buffer(AVHWFramesContext *hwfc, AVFrame *frame)
{
    WebGPUDevicePriv *priv  = hwfc->device_ctx->hwctx;
    WebGPUFramesPriv *fpriv = hwfc->hwctx;

    AVWebGPUFrame *f = av_mallocz(sizeof(AVWebGPUFrame));
    if (!f)
        return AVERROR(ENOMEM);

    WGPUTextureDescriptor tex_desc = {
        .usage         = fpriv->p.usage,
        .dimension     = WGPUTextureDimension_2D,
        .size          = (WGPUExtent3D){ hwfc->width, hwfc->height, 1 },
        .format        = fpriv->p.format,
        .mipLevelCount = 1,
        .sampleCount   = 1,
    };

    f->texture = wgpuDeviceCreateTexture(priv->p.device, &tex_desc);
    if (!f->texture) {
        av_free(f);
        return AVERROR_EXTERNAL;
    }
    f->view = wgpuTextureCreateView(f->texture, NULL);

    frame->data[0] = (uint8_t *)f;
    frame->format  = AV_PIX_FMT_WEBGPU;
    frame->width   = hwfc->width;
    frame->height  = hwfc->height;
    frame->buf[0]  = av_buffer_create((uint8_t *)f, sizeof(AVWebGPUFrame),
                                      webgpu_frame_free, hwfc, 0);
    if (!frame->buf[0]) {
        webgpu_frame_free(hwfc, (uint8_t *)f);
        return AVERROR(ENOMEM);
    }
    return 0;
}

static int webgpu_transfer_data_to(AVHWFramesContext *hwfc, AVFrame *dst, const AVFrame *src)
{
    WebGPUDevicePriv *priv = hwfc->device_ctx->hwctx;
    AVWebGPUFrame *dst_f   = (AVWebGPUFrame *)dst->data[0];

    if (src->format != AV_PIX_FMT_RGBA) {
        av_log(hwfc, AV_LOG_ERROR, "Only AV_PIX_FMT_RGBA source is supported.\n");
        return AVERROR(EINVAL);
    }

    WGPUTexelCopyTextureInfo copy_dest = { .texture = dst_f->texture };
    WGPUTexelCopyBufferLayout layout = {
        .bytesPerRow  = src->linesize[0],
        .rowsPerImage = src->height,
    };
    WGPUExtent3D write_size = { src->width, src->height, 1 };

    wgpuQueueWriteTexture(priv->p.queue, &copy_dest, src->data[0],
                          src->linesize[0] * src->height, &layout, &write_size);
    return 0;
}
