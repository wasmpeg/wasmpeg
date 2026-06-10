.PHONY: all verify build build-cpu build-webgpu test fate fate-parse compat size clean

all: build

build:
	bash scripts/build.sh

build-cpu:
	TARGET=cpu bash scripts/build.sh

build-webgpu:
	TARGET=webgpu bash scripts/build.sh

verify:
	node tests/test.mjs
	node tests/fate-runner.mjs

test:
	node tests/test.mjs

# decode-correctness report — exact checksum match vs vendored FATE refs (needs the gpl-cpu build)
fate:
	node tests/fate.mjs

fate-parse:
	node tests/fate-runner.mjs

# liveness report — decode runs without erroring (needs the gpl-cpu build)
compat:
	node tests/compat.mjs

size:
	bash tests/size.sh

clean:
	rm -rf dist/ build-cpu/ build-webgpu/
