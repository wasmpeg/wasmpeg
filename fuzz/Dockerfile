FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
        clang lld libclang-rt-18-dev make pkg-config zlib1g-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY vendor/ffmpeg /src/ffmpeg
COPY fuzz/build.sh /src/build.sh
COPY fuzz/targets.txt /src/targets.txt
RUN chmod +x /src/build.sh && /src/build.sh

COPY fuzz/run.sh /out/run.sh
COPY fuzz/targets.txt /out/targets.txt
RUN chmod +x /out/run.sh
WORKDIR /out
ENTRYPOINT ["/out/run.sh"]
