#!/bin/bash
# Runs every fuzz binary in /out for a bounded time each, against a corpus
# that persists across runs (mount -v to a host/cache dir at /corpus to get
# real cross-run growth — an empty /corpus works fine too, libFuzzer bootstraps
# coverage from nothing, it just takes longer to get there).
#
# Crashes are written to /crashes/<target>-<hash> and kept — a non-empty
# /crashes at the end means this run found something real, and the script
# exits non-zero so CI fails loudly instead of silently swallowing it.
set -euo pipefail

TARGETS_FILE=${TARGETS_FILE:-/out/targets.txt}
CORPUS_ROOT=${CORPUS_ROOT:-/corpus}
CRASH_DIR=${CRASH_DIR:-/crashes}
TIME_PER_TARGET=${TIME_PER_TARGET:-300}   # seconds, per target
RSS_LIMIT_MB=${RSS_LIMIT_MB:-2048}

mkdir -p "$CORPUS_ROOT" "$CRASH_DIR"

found_crash=0
while IFS=: read -r kind name; do
    target="${kind}_${name}"
    bin="/out/$target"
    [ -x "$bin" ] || { echo "skip $target: no binary at $bin" >&2; continue; }

    corpus="$CORPUS_ROOT/$target"
    mkdir -p "$corpus"

    # Real-world samples matching this codec, if the fate-suite is mounted at
    # /fate-suite (optional — CI doesn't have it, a local run pointed at the
    # repo's fate-suite/ does). One-time seed: only copies in on an empty
    # corpus, so it doesn't fight libFuzzer's own minimization on every run.
    if [ -d /fate-suite ] && [ -z "$(ls -A "$corpus" 2>/dev/null)" ]; then
        find /fate-suite -iname "*${name}*" -type f -size -200k 2>/dev/null \
            | head -50 | xargs -I{} cp {} "$corpus/" 2>/dev/null || true
    fi

    echo "=== $target — ${TIME_PER_TARGET}s, corpus: $(ls "$corpus" | wc -l) seeds ==="
    if ! "$bin" \
            -max_total_time="$TIME_PER_TARGET" \
            -rss_limit_mb="$RSS_LIMIT_MB" \
            -timeout=25 \
            -artifact_prefix="$CRASH_DIR/${target}-" \
            "$corpus" 2>&1 | tail -20
    then
        found_crash=1
    fi
done < <(grep -E '^(dec|dem):' "$TARGETS_FILE")

if [ "$(ls -A "$CRASH_DIR" 2>/dev/null)" ]; then
    echo "=== crashes found: ==="
    ls -la "$CRASH_DIR"
    found_crash=1
fi

exit "$found_crash"
