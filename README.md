# wasmpeg

FFmpeg in the browser, with WebGPU acceleration.

```js
import { FFmpeg } from 'wasmpeg';

const ff = new FFmpeg();
await ff.load();
await ff.writeFile('input.mp4', await fetchFile(source));
await ff.exec(['-i', 'input.mp4', 'output.webm']);
const data = await ff.readFile('output.webm');
```

---

Powered by [FFmpeg](https://ffmpeg.org) (LGPL-2.1-or-later).
Not affiliated with or endorsed by the FFmpeg project.
