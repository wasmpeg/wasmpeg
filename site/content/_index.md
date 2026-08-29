---
title: wasmpeg
---

{{< cardgrid >}}
{{< card title="Real FFmpeg, not a reimplementation" icon="code" >}}
Compiled from unmodified FFmpeg source. Every codec behaves exactly like the CLI you already know.
{{< /card >}}
{{< card title="Built for the decode loop" icon="film" >}}
The high-level API is shaped around getting frames on screen, not around shelling out to a CLI in a worker.
{{< /card >}}
{{< card title="Small enough to ship" icon="weight-hanging" >}}
{{% param "sizeGzMB" %}} MB gzipped for the LGPL build. No bundled decoders you don't use.
{{< /card >}}
{{< /cardgrid >}}
