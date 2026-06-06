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
