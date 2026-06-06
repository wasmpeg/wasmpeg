#!/bin/bash
# Live size comparison — no hardcoded values.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

fmt_size() {
    awk -v b="$1" 'BEGIN { printf "%.2f MB raw", b/1048576 }'
}

fmt_gz() {
    local gz
    gz=$(gzip -c "$1" | wc -c | tr -d ' ')
    awk -v b="$gz" 'BEGIN { printf "%.2f MB gz", b/1048576 }'
}

npm_unpacked_size() {
    local size
    size=$(npm show "$1" --json 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if isinstance(d, list): d = d[-1]
    print(d.get('dist', {}).get('unpackedSize', ''))
except: print('')
" 2>/dev/null)
    [ -n "$size" ] && awk -v b="$size" 'BEGIN { printf "%.1f MB", b/1048576 }' || echo "unavailable"
}

echo ""
echo "=== WASM size comparison ==="
echo ""
echo "Ours:"
for t in cpu webgpu; do
    wasm="$ROOT/dist/${t}.wasm"
    if [ -f "$wasm" ]; then
        bytes=$(wc -c < "$wasm" | tr -d ' ')
        printf "  %-16s  %s   %s\n" "${t}.wasm" "$(fmt_size "$bytes")" "$(fmt_gz "$wasm")"
    else
        printf "  %-16s  not built\n" "${t}.wasm"
    fi
done

echo ""
echo "Reference (npm):"
for pkg in "@ffmpeg/core" "@ffmpeg/core-mt"; do
    printf "  %-24s  %s (unpacked)\n" "$pkg" "$(npm_unpacked_size "$pkg")"
done
echo ""
