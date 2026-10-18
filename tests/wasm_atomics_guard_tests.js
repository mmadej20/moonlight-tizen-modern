'use strict';

// The Samsung Emscripten (fastcomp 1.39.4.7) lowers 64-bit atomics to library calls, and its
// compare-exchange call has the wrong signature: asm2wasm warns "adding operands in call to
// ___atomic_compare_exchange_8". A thread that loops on `std::atomic<int64_t>::compare_exchange_*`
// then spins forever. It froze the connection thread at its first status message and left the
// application on "Starting <game>..." for good (see docs/2026-10-18-stream-hang-investigation.md).
// 32-bit atomics compile to real wasm instructions, so everything shared between threads stays 32 bits wide.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

const wasmDir = 'wasm';
const sources = fs.readdirSync(wasmDir)
  .filter((name) => /\.(hpp|cpp|h|c)$/.test(name))
  .map((name) => path.join(wasmDir, name));

const wide = /std::atomic<\s*(?:u?int64_t|(?:unsigned\s+)?long\s+long|size_t|double)\s*>/;

// The statistics header is shared by every media thread and is the one that must never use wide atomics.
const health = read('wasm/stream_health.hpp');
assert(!wide.test(health), 'stream_health.hpp must not declare a 64-bit std::atomic');

// Nowhere in the WASM sources may a compare-exchange run on a 64-bit atomic. Plain fetch_add and exchange on
// 64-bit counters are the only wide operations that are known to work (diagnostic_log.hpp).
const allowedWide = new Set([path.join('wasm', 'diagnostic_log.hpp')]);
sources.forEach((file) => {
  const text = read(file).replace(/\/\/.*$/gm, '');
  const declared = text.match(new RegExp(wide.source + '\\s+(\\w+)', 'g')) || [];
  if (declared.length === 0) return;
  assert(allowedWide.has(file), file + ' declares a 64-bit std::atomic: ' + declared.join(', '));
  declared.forEach((declaration) => {
    const name = declaration.split(/\s+/).pop();
    assert(!new RegExp(name + '\\s*\\.\\s*compare_exchange').test(text),
      file + ' runs compare_exchange on the 64-bit atomic ' + name);
  });
});

console.log('wasm atomics guard tests passed');
