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
