.PHONY: all verify build build-cpu build-webgpu test fate size clean

all: build

build:
	bash scripts/build.sh

build-cpu:
	TARGET=cpu bash scripts/build.sh

build-webgpu:
	TARGET=webgpu bash scripts/build.sh

verify:
	node tests/test.mjs
	node tests/fate.mjs

test:
	node tests/test.mjs

fate:
	node tests/fate.mjs

size:
	bash tests/size.sh

clean:
	rm -rf dist/ build-cpu/ build-webgpu/
