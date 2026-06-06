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
