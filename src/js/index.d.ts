/** Type definitions for wasmpeg. */

/** Anything the high-level API accepts as a media source. */
export type WasmpegInput =
    | Uint8Array
    | ArrayBuffer
    | Blob
    | File
    | string
    | HTMLVideoElement
    | HTMLCanvasElement
    | ImageData;

export type Fps = number | { num: number; den: number };

export interface Decoder {
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    /** RGBA8 pixels, or null at end of stream. Defaults to the native size. */
    nextFrame(dstW?: number, dstH?: number): Uint8ClampedArray | null;
    close(): void;
}

export interface AudioDecoder {
    readonly channels: number;
    readonly sampleRate: number;
    /** Interleaved f32 samples in [-1, 1], or null at end of stream. */
    nextSamples(): Float32Array | null;
    close(): void;
}

export interface Encoder {
    pushRgba(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, ptsMs: number): void;
    finish(): Uint8Array;
    close(): void;
}

export type StreamType = 'video' | 'audio' | 'data' | 'subtitle' | 'attachment' | 'unknown';

export interface ProbeResult {
    format: string;
    /** Seconds, or null when the container does not say. */
    duration: number | null;
    /** Overall container bitrate in kb/s, or -1 if unknown. */
    bitrate: number;
    streams: Array<{ index: number; type: StreamType }>;
    video: { width: number; height: number; fpsNum: number; fpsDen: number };
    audio: { sampleRate: number; channels: number };
}

export interface EncodeOptions {
    /** Container/muxer name. Defaults to 'image2pipe'. */
    fmt?: string;
    /** Encoder name. Defaults to 'mjpeg'. */
    codec?: string;
    width?: number;
    height?: number;
    fps?: Fps;
    /** Target bitrate in bits/s. 0 uses the codec default. */
    bitrate?: number;
    /** Stop after this many frames. */
    frames?: number;
    /** Force an input demuxer. */
    format?: string;
}

export interface LoadOptions {
    /** Explicit path to a built module (dist/cpu.js or dist/webgpu.js). */
    wasmPath?: string;
}

export interface Wasmpeg {
    load(opts?: LoadOptions): Promise<void>;
    scale(input: WasmpegInput, dstW: number, dstH: number, filter?: string): Promise<Uint8ClampedArray>;
    decode(input: WasmpegInput, opts?: { format?: string }): Promise<Decoder>;
    decodeAudio(input: WasmpegInput, opts?: { format?: string }): Promise<AudioDecoder>;
    probe(input: WasmpegInput): Promise<ProbeResult>;
    encode(input: WasmpegInput, opts?: EncodeOptions): Promise<Uint8Array>;
    run(input: WasmpegInput, args: string | string[]): Promise<Uint8ClampedArray | Decoder>;
}

export interface ParsedArgs {
    inputs: Array<{ url: string; options: Record<string, string | true> }>;
    outputs: Array<{ url: string; options: Record<string, string | true> }>;
    global: Record<string, string | true>;
}

export interface LogEvent { type: 'stdout' | 'stderr'; message: string }
export interface ProgressEvent { progress: string }

export declare class FFmpeg {
    readonly loaded: boolean;
    on(event: 'log', handler: (e: LogEvent) => void): this;
    on(event: 'progress', handler: (e: ProgressEvent) => void): this;
    off(event: 'log', handler: (e: LogEvent) => void): this;
    off(event: 'progress', handler: (e: ProgressEvent) => void): this;
    load(opts?: LoadOptions): Promise<void>;
    writeFile(path: string, data: Uint8Array | Blob): Promise<void>;
    readFile(path: string): Promise<Uint8Array>;
    deleteFile(path: string): Promise<void>;
    createDir(path: string): Promise<void>;
    listDir(path: string): Promise<string[]>;
    exec(args: string[], opts?: { timeout?: number }): Promise<Uint8ClampedArray | Decoder | AudioDecoder>;
    terminate(): void;
}

export interface Gpu {
    load(opts?: LoadOptions): Promise<void>;
    onLog(handler: (e: LogEvent) => void): () => void;
    offLog(handler: (e: LogEvent) => void): void;
    scale(srcRgba: Uint8Array | Uint8ClampedArray, srcW: number, srcH: number,
          dstW: number, dstH: number, filtergraph?: string): Uint8ClampedArray;
    createDecoder(fileBytes: Uint8Array, fmtName?: string): Decoder;
    createDecoderFile(path: string): Decoder;
    createAudioDecoder(fileBytes: Uint8Array, fmtName?: string): AudioDecoder;
    probe(fileBytes: Uint8Array): ProbeResult;
    createEncoder(opts: { fmt: string; codec: string; width?: number; height?: number; fps?: Fps; bitrate?: number }): Encoder;
    hasWebGPU(): boolean;
    benchGpu(srcW: number, srcH: number, dstW: number, dstH: number, iters: number): number;
    benchCpu(srcW: number, srcH: number, dstW: number, dstH: number, iters: number): number;
    readonly FS: unknown;
}

export declare const gpu: Gpu;
export declare const wasmpeg: Wasmpeg;
export declare function exec(input: WasmpegInput, args: string | string[]): Promise<Uint8ClampedArray | Decoder | AudioDecoder>;
export declare function parseArgs(args: string | string[]): ParsedArgs;

declare const _default: Wasmpeg;
export default _default;
