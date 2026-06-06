/**
 * FFmpeg class — drop-in replacement for @ffmpeg/ffmpeg v0.12.
 *
 * An existing ffmpeg.wasm snippet should run unchanged:
 *   const ff = new FFmpeg();
 *   await ff.load();
 *   await ff.writeFile('input.mp4', data);
 *   await ff.exec(['-i', 'input.mp4', 'output.webm']);
 *   const out = await ff.readFile('output.webm');
 */

export class FFmpeg {
    #mod    = null;
    #log    = [];
    #prog   = [];

    get loaded() { return this.#mod !== null; }

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
        if (this.#mod) return;

        const path = wasmPath ?? (
            typeof navigator !== 'undefined' && navigator.gpu
                ? new URL('../../dist/webgpu.js', import.meta.url).href
                : new URL('../../dist/cpu.js',    import.meta.url).href
        );

        const emit = (type, message) => this.#log.forEach(h => h({ type, message }));

        const { default: factory } = await import(/* @vite-ignore */ path);
        this.#mod = await factory({
            print:    msg => emit('stdout', msg),
            printErr: msg => {
                emit('stderr', msg);
                const m = msg.match(/time=(\S+)/);
                if (m) this.#prog.forEach(h => h({ progress: m[1] }));
            },
        });
    }

    #assertLoaded() {
        if (!this.#mod) throw new Error('call load() first');
    }

    async writeFile(path, data) {
        this.#assertLoaded();
        const buf = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
        this.#mod.FS.writeFile(path, buf);
    }

    async readFile(path) {
        this.#assertLoaded();
        return this.#mod.FS.readFile(path);
    }

    async deleteFile(path) {
        this.#assertLoaded();
        this.#mod.FS.unlink(path);
    }

    async createDir(path) {
        this.#assertLoaded();
        this.#mod.FS.mkdir(path);
    }

    async listDir(path) {
        this.#assertLoaded();
        return this.#mod.FS.readdir(path);
    }

    async exec(args, { timeout = 0 } = {}) {
        this.#assertLoaded();
        return new Promise((resolve, reject) => {
            try {
                const ret = this.#mod.callMain(args);
                resolve(ret ?? 0);
            } catch (e) {
                reject(e);
            }
        });
    }

    terminate() {
        this.#mod = null;
        this.#log = [];
        this.#prog = [];
    }
}
