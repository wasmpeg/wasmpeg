/*
 * This file is part of FFmpeg.
 *
 * FFmpeg is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 */

#ifndef AVUTIL_HWCONTEXT_WEBGPU_H
#define AVUTIL_HWCONTEXT_WEBGPU_H

#include <webgpu/webgpu.h>
#include "frame.h"

/**
 * @file
 * API-specific header for AV_HWDEVICE_TYPE_WEBGPU.
 */

/**
 * Main WebGPU context, allocated as AVHWDeviceContext.hwctx.
 */
typedef struct AVWebGPUDeviceContext {
    WGPUInstance instance;
    WGPUAdapter  adapter;
    WGPUDevice   device;
    WGPUQueue    queue;
} AVWebGPUDeviceContext;

/**
 * Allocated as AVHWFramesContext.hwctx.
 *
 * usage and format are optional; zero values fall back to
 * (CopyDst|CopySrc|StorageBinding|TextureBinding) and RGBA8Unorm respectively.
 */
typedef struct AVWebGPUFramesContext {
    WGPUTextureUsage  usage;
    WGPUTextureFormat format;
} AVWebGPUFramesContext;

/**
 * Hardware frame. AVFrame->data[0] points to this when format is AV_PIX_FMT_WEBGPU.
 */
typedef struct AVWebGPUFrame {
    WGPUTexture     texture;
    WGPUTextureView view;
} AVWebGPUFrame;

#endif /* AVUTIL_HWCONTEXT_WEBGPU_H */
