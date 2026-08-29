/**
 * FFmpeg class — drop-in replacement for @ffmpeg/ffmpeg v0.12.
 *
 * An existing ffmpeg.wasm snippet should run unchanged:
 *   const ff = new FFmpeg();
 *   await ff.load();
 *   await ff.writeFile('input.mp4', data);
 *   await ff.exec(['-i', 'input.mp4', 'output.webm']);
 *   const out = await ff.readFile('output.webm');
 *
 * This class is a thin surface over the same module `gpu` and `exec()` use.
 * Loading a second instance would double the ~7 MB of resident wasm and give
 * writeFile() a filesystem that exec() cannot see.
 */

import { exec, parseArgs } from './exec.mjs';
import { gpu } from './gpu.js';

export class FFmpeg {
    #loaded = false;
    #log    = [];
    #prog   = [];
    #unsub  = null;

    get loaded() { return this.#loaded; }

    on(event, handler) {
        if (event === 'log')      this.#log.push(handler);
        if (event === 'progress') this.#prog.push(handler);
        return this;
    }

    off(event, handler) {
        if (event === 'log')      this.#log = this.#log.filter(h => h !== handler);
        if (event === 'progress') this.#prog = this.#prog.filter(h => h !== handler);
        return this;
    }

    async load({ wasmPath } = {}) {
        if (this.#loaded) return;
        await gpu.load(wasmPath ? { wasmPath } : {});

        this.#unsub = gpu.onLog(({ type, message }) => {
            for (const h of this.#log) h({ type, message });
            if (type === 'stderr') {
                const m = message.match(/time=(\S+)/);
                if (m) for (const h of this.#prog) h({ progress: m[1] });
            }
        });

        this.#loaded = true;
    }

    #fs() {
        if (!this.#loaded) throw new Error('call load() first');
        return gpu.FS;
    }

    async writeFile(path, data) {
        const buf = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
        this.#fs().writeFile(path, buf);
    }

    async readFile(path)   { return this.#fs().readFile(path); }
    async deleteFile(path) { this.#fs().unlink(path); }
    async createDir(path)  { this.#fs().mkdir(path); }
    async listDir(path)    { return this.#fs().readdir(path); }

    async exec(args, { timeout = 0 } = {}) {
        const fs     = this.#fs();
        const parsed = parseArgs(args);
        const inputPath = parsed.inputs[0]?.url;
        if (!inputPath) throw new Error('exec(): no -i input specified');
        const inputBytes = fs.readFile(inputPath);
        const run = exec(inputBytes, args);
        if (!timeout) return run;
        return Promise.race([
            run,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`exec() timed out after ${timeout}ms`)), timeout)),
        ]);
    }

    terminate() {
        // The module is shared, so this releases only what this instance owns:
        // its log subscription and its listeners. Sessions opened by exec() are
        // closed by exec() itself.
        this.#unsub?.();
        this.#unsub  = null;
        this.#loaded = false;
        this.#log    = [];
        this.#prog   = [];
    }
}
