'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const src = 'moonlight-common-c/src/';
const videoStream = read(src + 'VideoStream.c');
const videoQueue = read(src + 'RtpVideoQueue.c');
const depacketizer = read(src + 'VideoDepacketizer.c');
const canaryHeader = read(src + 'VideoCanary.h');
const canarySource = read(src + 'VideoCanary.c');
const cmake = read('CMakeLists.txt');

// The guard exists only in a diagnostic build. The three files that own the packet buffers know nothing but the
// PACKET_* macros, which are plain malloc() and free() in a normal build.
for (const [name, text] of [['VideoStream.c', videoStream], ['RtpVideoQueue.c', videoQueue], ['VideoDepacketizer.c', depacketizer]]) {
  assert(/#include "VideoCanary\.h"/.test(text), name + ' includes the macros');
  assert(!/videoCanary|VIDEO_CANARY/.test(text), name + ' does not name the guard directly');
}

const normalBranch = canaryHeader.slice(canaryHeader.indexOf('#else'));
assert(/#define PACKET_BUFFER_MALLOC\(size\) malloc\(size\)/.test(normalBranch));
assert(/#define PACKET_BUFFER_FREE\(buffer\) free\(buffer\)/.test(normalBranch));
assert(/#define PACKET_ENTRY_FREE\(entry, allocPtr\) free\(allocPtr\)/.test(normalBranch));
assert(/#define PACKET_BUFFER_CONFIGURE\(size, entryOffset\) \(\(void\)0\)/.test(normalBranch));
assert(/#define PACKET_BUFFER_SWEEP\(when\) \(\(void\)0\)/.test(normalBranch));
assert(/#define PACKET_PATH_EVENT\(what, a, b\) \(\(void\)0\)/.test(normalBranch));
assert(/^#ifdef MOONLIGHT_VIDEO_CANARY/m.test(canaryHeader));

// The source is empty without the macro
const sourceLines = canarySource.split(/\r?\n/).filter((line) => line.trim() !== '' && !/^\/\//.test(line));
assert.strictEqual(sourceLines[0], '#ifdef MOONLIGHT_VIDEO_CANARY');
assert.strictEqual(sourceLines[sourceLines.length - 1], '#endif');

// Every packet buffer is made and freed through the macros: no plain free() of a packet is left
assert(!/\bfree\(entry->packet\)/.test(videoQueue));
assert(!/\bfree\(packets\[i\]\)/.test(videoQueue));
assert(!/\bfree\(parityEntry->packet\)/.test(videoQueue));
assert(!/malloc\(packetBufferSize\)/.test(videoQueue));
assert(!/\bfree\(\w+->allocPtr\)/.test(depacketizer));
assert(!/\bfree\(buffer\)/.test(videoStream));
assert(!/malloc\(bufferSize\)/.test(videoStream));
assert.strictEqual((videoQueue.match(/PACKET_BUFFER_FREE\(/g) || []).length, 5, 'purge, recovery failure, validation drop, cleanup, parity');
assert.strictEqual((videoQueue.match(/PACKET_BUFFER_MALLOC\(packetBufferSize\)/g) || []).length, 1);
assert.strictEqual((depacketizer.match(/PACKET_ENTRY_FREE\(/g) || []).length, 3, 'frame cleanup, decode unit cleanup, unwanted packet');
assert(/PACKET_BUFFER_MALLOC\(bufferSize\)/.test(videoStream));

// The receive loop sets the sizes up, checks the buffer it holds before and after every receive and sweeps all of them
assert(/PACKET_BUFFER_CONFIGURE\(bufferSize, decryptedSize\)/.test(videoStream));
assert(/PACKET_BUFFER_CHECK\(buffer, "while the thread held the buffer"/.test(videoStream));
assert(/PACKET_BUFFER_CHECK\(buffer, "by the receive"/.test(videoStream));
assert(/\(\+\+sweepTick & 31\) == 0\) \{\s+PACKET_BUFFER_SWEEP\("the receive loop"\)/.test(videoStream));

// The queue says what it does, to be printed with a report
assert(/PACKET_PATH_EVENT\("purge"/.test(videoQueue));
assert(/PACKET_PATH_EVENT\("recover"/.test(videoQueue));
assert(/PACKET_PATH_EVENT\("submit"/.test(videoQueue));

// The guard keeps a copy of the chunk head without the PINUSE bit, checks it and does not free a buffer twice
assert(/#define HEAD_MASK \(~\(uint32_t\)1\)/.test(canarySource));
assert(/freed a buffer that is not registered \(freed twice\?\)/.test(canarySource));
assert(/\(char\*\)entry == \(char\*\)allocPtr \+ configuredEntryOffset/.test(canarySource));

// The macro is defined only by the diagnostic option of CMake, together with the probes; the source is always in the
// library (the list of sources is written out, there is no glob) and is empty without the macro
assert(/if\(MOONLIGHT_ALLOC_STRESS\)[\s\S]*target_compile_definitions\(moonlight-common-c PRIVATE MOONLIGHT_VIDEO_CANARY=1\)[\s\S]*endif\(\)/.test(cmake));
assert(/wasm\/udp_recv_probe\.cpp/.test(cmake));
assert(!/MOONLIGHT_VIDEO_CANARY/.test(cmake.replace(/if\(MOONLIGHT_ALLOC_STRESS\)[\s\S]*?endif\(\)/, '')), 'nothing else defines it');
assert(/add_library\(moonlight-common-c STATIC[\s\S]*moonlight-common-c\/src\/VideoCanary\.c[\s\S]*?\)/.test(cmake), 'the source is in the library');

console.log('video canary wiring tests passed');
