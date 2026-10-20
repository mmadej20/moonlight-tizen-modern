'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const videoStream = read('moonlight-common-c/src/VideoStream.c');
const cmake = read('CMakeLists.txt');

// The guard behind the video packet buffer exists only in a diagnostic build: every piece of it sits inside the macro,
// so that a normal build allocates exactly bufferSize as before
const canaryLines = videoStream.split(/\r?\n/);
let depth = 0;
let outside = 0;
for (const line of canaryLines) {
  if (/^#ifdef MOONLIGHT_VIDEO_CANARY/.test(line)) depth++;
  else if (depth > 0 && /^#endif/.test(line)) depth--;
  else if (depth === 0 && /videoCanary|VIDEO_CANARY/.test(line)) outside++;
}
assert.strictEqual(outside, 0, 'the canary code is only reachable with MOONLIGHT_VIDEO_CANARY');

// The default allocation is unchanged
assert(/#else\s+buffer = \(char\*\)malloc\(bufferSize\);\s+#endif/.test(videoStream));
// The diagnostic one asks for the guard bytes, fills them and checks them before and after the receive
assert(/malloc\(bufferSize \+ VIDEO_CANARY_SIZE\)/.test(videoStream));
assert(/videoCanaryFill\(buffer, bufferSize\)/.test(videoStream));
assert(/videoCanaryCheck\("by the receive"/.test(videoStream));
assert(/videoCanaryCheck\("while the thread held the buffer"/.test(videoStream));
assert(/recv returned %d, more than the %d bytes that were asked for/.test(videoStream));

// The macro is defined only by the diagnostic option of CMake, together with the probes
assert(/if\(MOONLIGHT_ALLOC_STRESS\)[\s\S]*target_compile_definitions\(moonlight-common-c PRIVATE MOONLIGHT_VIDEO_CANARY=1\)[\s\S]*endif\(\)/.test(cmake));
assert(/wasm\/udp_recv_probe\.cpp/.test(cmake));
assert(!/MOONLIGHT_VIDEO_CANARY/.test(cmake.replace(/if\(MOONLIGHT_ALLOC_STRESS\)[\s\S]*?endif\(\)/, '')), 'nothing else defines it');

console.log('video canary wiring tests passed');
