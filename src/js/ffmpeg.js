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
