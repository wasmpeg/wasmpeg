# FATE tests for WebGPU hwcontext and filters.
#
# These tests require:
#   - CONFIG_WEBGPU (--enable-webgpu in configure)
#   - Node.js >= 18 with Playwright installed (cd tests/webgpu && npm install)
#   - Headless Chromium with WebGPU support (npx playwright install chromium)
#   - The WASM test binary built via: make fate-webgpu-build
#
# Run individually:
#   make fate-api-webgpu-device
#   make fate-api-webgpu-scale
#
# Or all at once:
#   make fate-webgpu

FATE_WEBGPU-$(CONFIG_WEBGPU) += fate-api-webgpu-device
FATE_WEBGPU-$(CONFIG_WEBGPU) += fate-api-webgpu-scale

FATE_WEBGPU = $(FATE_WEBGPU-yes)

WEBGPU_RUNNER = node $(SRC_PATH)/tests/webgpu/runner.mjs \
                --wasm-dir $(TARGET_PATH)/tests/api \
                --wasm-name api-webgpu-test

fate-api-webgpu-device: $(APITESTSDIR)/api-webgpu-test.js
fate-api-webgpu-device: CMD = run $(WEBGPU_RUNNER) --filter hwcontext
fate-api-webgpu-device: CMP = null

fate-api-webgpu-scale: $(APITESTSDIR)/api-webgpu-test.js
fate-api-webgpu-scale: CMD = run $(WEBGPU_RUNNER) --filter scale_webgpu
fate-api-webgpu-scale: CMP = null

FATE-yes += $(FATE_WEBGPU)

fate-webgpu: $(FATE_WEBGPU)
