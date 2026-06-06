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

#include <webgpu/webgpu.h>

#include "libavutil/hwcontext.h"
#include "libavutil/hwcontext_webgpu.h"
#include "libavutil/internal.h"
#include "libavutil/opt.h"
#include "filters.h"
#include "scale_eval.h"
#include "video.h"

#define WORKGROUP_SIZE 8

static const char wgsl_scale_bilinear[] =
    "@group(0) @binding(0) var input_tex     : texture_2d<f32>;\n"
    "@group(0) @binding(1) var input_sampler : sampler;\n"
    "@group(0) @binding(2) var output_tex    : texture_storage_2d<rgba8unorm, write>;\n"
    "\n"
    "@compute @workgroup_size(" AV_STRINGIFY(WORKGROUP_SIZE) ", " AV_STRINGIFY(WORKGROUP_SIZE) ")\n"
    "fn main(@builtin(global_invocation_id) gid: vec3<u32>) {\n"
    "    let out_size = textureDimensions(output_tex);\n"
    "    let pos      = vec2<u32>(gid.x, gid.y);\n"
    "    if (pos.x >= out_size.x || pos.y >= out_size.y) { return; }\n"
    "    let uv    = (vec2<f32>(pos) + 0.5) / vec2<f32>(out_size);\n"
    "    let color = textureSampleLevel(input_tex, input_sampler, uv, 0.0);\n"
    "    textureStore(output_tex, pos, color);\n"
    "}\n";

typedef struct ScaleWebGPUContext {
    char *w_expr;
    char *h_expr;

    int initialized;
    WGPUShaderModule        shader_module;
    WGPUBindGroupLayout     bind_group_layout;
    WGPUPipelineLayout      pipeline_layout;
    WGPUComputePipeline     pipeline;
    WGPUSampler             sampler;

    int out_width;
    int out_height;
} ScaleWebGPUContext;

static av_cold void scale_webgpu_uninit(AVFilterContext *avctx)
{
    ScaleWebGPUContext *s = avctx->priv;
    if (s->pipeline)          wgpuComputePipelineRelease(s->pipeline);
    if (s->pipeline_layout)   wgpuPipelineLayoutRelease(s->pipeline_layout);
    if (s->bind_group_layout) wgpuBindGroupLayoutRelease(s->bind_group_layout);
    if (s->sampler)           wgpuSamplerRelease(s->sampler);
    if (s->shader_module)     wgpuShaderModuleRelease(s->shader_module);
}

static int init_pipeline(AVFilterContext *avctx, WGPUDevice device)
{
    ScaleWebGPUContext *s = avctx->priv;

    WGPUShaderSourceWGSL wgsl_src = {
        .chain = { .sType = WGPUSType_ShaderSourceWGSL },
        .code  = { .data = wgsl_scale_bilinear,
                   .length = strlen(wgsl_scale_bilinear) },
    };
    WGPUShaderModuleDescriptor shader_desc = {
        .nextInChain = &wgsl_src.chain,
    };
    s->shader_module = wgpuDeviceCreateShaderModule(device, &shader_desc);
    if (!s->shader_module) {
        av_log(avctx, AV_LOG_ERROR, "Failed to create WGSL shader module.\n");
        return AVERROR_EXTERNAL;
    }

    WGPUBindGroupLayoutEntry bgl_entries[] = {
        {
            .binding    = 0,
            .visibility = WGPUShaderStage_Compute,
            .texture    = {
                .sampleType    = WGPUTextureSampleType_Float,
                .viewDimension = WGPUTextureViewDimension_2D,
            },
        },
        {
            .binding    = 1,
            .visibility = WGPUShaderStage_Compute,
            .sampler    = { .type = WGPUSamplerBindingType_Filtering },
        },
        {
            .binding        = 2,
            .visibility     = WGPUShaderStage_Compute,
            .storageTexture = {
                .access        = WGPUStorageTextureAccess_WriteOnly,
                .format        = WGPUTextureFormat_RGBA8Unorm,
                .viewDimension = WGPUTextureViewDimension_2D,
            },
        },
    };
    WGPUBindGroupLayoutDescriptor bgl_desc = {
        .entryCount = FF_ARRAY_ELEMS(bgl_entries),
        .entries    = bgl_entries,
    };
    s->bind_group_layout = wgpuDeviceCreateBindGroupLayout(device, &bgl_desc);
    if (!s->bind_group_layout) {
        av_log(avctx, AV_LOG_ERROR, "Failed to create bind group layout.\n");
        return AVERROR_EXTERNAL;
    }

    WGPUPipelineLayoutDescriptor pl_desc = {
        .bindGroupLayoutCount = 1,
        .bindGroupLayouts     = &s->bind_group_layout,
    };
    s->pipeline_layout = wgpuDeviceCreatePipelineLayout(device, &pl_desc);
    if (!s->pipeline_layout) {
        av_log(avctx, AV_LOG_ERROR, "Failed to create pipeline layout.\n");
        return AVERROR_EXTERNAL;
    }

    WGPUSamplerDescriptor sampler_desc = {
        .magFilter    = WGPUFilterMode_Linear,
        .minFilter    = WGPUFilterMode_Linear,
        .addressModeU = WGPUAddressMode_ClampToEdge,
        .addressModeV = WGPUAddressMode_ClampToEdge,
    };
    s->sampler = wgpuDeviceCreateSampler(device, &sampler_desc);
    if (!s->sampler) {
        av_log(avctx, AV_LOG_ERROR, "Failed to create sampler.\n");
        return AVERROR_EXTERNAL;
    }

    WGPUComputePipelineDescriptor cp_desc = {
        .layout  = s->pipeline_layout,
        .compute = {
            .module     = s->shader_module,
            .entryPoint = { .data = "main", .length = 4 },
        },
    };
    s->pipeline = wgpuDeviceCreateComputePipeline(device, &cp_desc);
    if (!s->pipeline) {
        av_log(avctx, AV_LOG_ERROR, "Failed to create compute pipeline.\n");
        return AVERROR_EXTERNAL;
    }

    s->initialized = 1;
    return 0;
}

static int scale_webgpu_filter_frame(AVFilterLink *inlink, AVFrame *in)
{
    AVFilterContext      *avctx   = inlink->dst;
    ScaleWebGPUContext   *s       = avctx->priv;
    AVFilterLink         *outlink = avctx->outputs[0];
    AVHWFramesContext    *in_hwfc = (AVHWFramesContext *)ff_filter_link(inlink)->hw_frames_ctx->data;
    AVWebGPUDeviceContext *wgpu   = in_hwfc->device_ctx->hwctx;
    AVWebGPUFrame        *in_f   = (AVWebGPUFrame *)in->data[0];
    int ret;

    if (!s->initialized) {
        ret = init_pipeline(avctx, wgpu->device);
        if (ret < 0)
            goto fail;
    }

    AVFrame *out = ff_get_video_buffer(outlink, outlink->w, outlink->h);
    if (!out) { ret = AVERROR(ENOMEM); goto fail; }

    AVWebGPUFrame *out_f = (AVWebGPUFrame *)out->data[0];

    WGPUBindGroupEntry bg_entries[] = {
        { .binding = 0, .textureView = in_f->view  },
        { .binding = 1, .sampler     = s->sampler  },
        { .binding = 2, .textureView = out_f->view },
    };
    WGPUBindGroupDescriptor bg_desc = {
        .layout     = s->bind_group_layout,
        .entryCount = FF_ARRAY_ELEMS(bg_entries),
        .entries    = bg_entries,
    };
    WGPUBindGroup bind_group = wgpuDeviceCreateBindGroup(wgpu->device, &bg_desc);
    if (!bind_group) {
        av_log(avctx, AV_LOG_ERROR, "Failed to create bind group.\n");
        av_frame_free(&out);
        ret = AVERROR_EXTERNAL;
        goto fail;
    }

    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(wgpu->device, NULL);
    WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(encoder, NULL);

    wgpuComputePassEncoderSetPipeline(pass, s->pipeline);
    wgpuComputePassEncoderSetBindGroup(pass, 0, bind_group, 0, NULL);
    wgpuComputePassEncoderDispatchWorkgroups(
        pass,
        (outlink->w + WORKGROUP_SIZE - 1) / WORKGROUP_SIZE,
        (outlink->h + WORKGROUP_SIZE - 1) / WORKGROUP_SIZE,
        1);
    wgpuComputePassEncoderEnd(pass);
    wgpuComputePassEncoderRelease(pass);

    WGPUCommandBuffer commands = wgpuCommandEncoderFinish(encoder, NULL);
    wgpuQueueSubmit(wgpu->queue, 1, &commands);
    wgpuCommandBufferRelease(commands);
    wgpuCommandEncoderRelease(encoder);
    wgpuBindGroupRelease(bind_group);

    ret = av_frame_copy_props(out, in);
    if (ret < 0) { av_frame_free(&out); goto fail; }

    out->width  = outlink->w;
    out->height = outlink->h;
    if (out->width != in->width || out->height != in->height)
        av_frame_side_data_remove_by_props(&out->side_data, &out->nb_side_data,
                                           AV_SIDE_DATA_PROP_SIZE_DEPENDENT);

    av_frame_free(&in);
    return ff_filter_frame(outlink, out);

fail:
    av_frame_free(&in);
    return ret;
}
