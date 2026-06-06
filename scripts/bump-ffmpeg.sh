#!/bin/bash
set -e

TAG="${1:?usage: bump-ffmpeg.sh <tag>  e.g. n8.2}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> pulling FFmpeg $TAG into vendor/ffmpeg/..."
git subtree pull --prefix=vendor/ffmpeg \
    https://github.com/FFmpeg/FFmpeg.git "$TAG" --squash

echo ""
echo "vendor/ffmpeg/ is now at $TAG"
echo "resolve any conflicts in the glue lines, then run: make verify"
