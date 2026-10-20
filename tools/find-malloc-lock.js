'use strict';

// Finds the address of the lock word of the allocator (dlmalloc's pthread mutex) in a linked module, from its
// disassembly (wasm-dis). malloc() and free() both start by calling pthread_mutex_lock on that mutex with a constant
// address; other mutexes passed with a constant to malloc (the global lock of the allocator) do not appear in free().
// The lock word is the second word of the mutex. The result is written as wasm/platform/malloc_lock.js for the guard
// of wasm/platform/futex_guard.js; the Docker build fails when the address cannot be determined unambiguously.
//
// Usage: node tools/find-malloc-lock.js <module.wat> <output .js>
// Runs on the Node 12 that ships with the Emscripten SDK, so it sticks to old syntax.

const fs = require('fs');

function functionBody(text, exportName) {
  const exported = new RegExp('\\(export "' + exportName + '" \\(func (\\$\\S+?)\\)\\)').exec(text);
  if (!exported) throw new Error('export ' + exportName + ' not found');
  const start = text.indexOf('\n (func ' + exported[1] + ' ');
  if (start < 0) throw new Error('body of ' + exportName + ' not found');
  const end = text.indexOf('\n (func ', start + 1);
  return text.slice(start, end < 0 ? text.length : end);
}

// Every (callee, constant argument) pair of a body, e.g. (call $5558 (i32.const 2666172))
function constantCalls(body) {
  const pairs = new Map();
  const pattern = /\(call (\$\S+)\s+\(i32\.const (\d+)\)\s*\)/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    pairs.set(match[1] + ' ' + match[2], { callee: match[1], address: Number(match[2]) });
  }
  return pairs;
}

// pthread_mutex_lock stores EBUSY (10) in the lock word with a compare and swap
function looksLikeMutexLock(text, callee) {
  const start = text.indexOf('\n (func ' + callee + ' ');
  if (start < 0) return false;
  const end = text.indexOf('\n (func ', start + 1);
  const body = text.slice(start, end < 0 ? text.length : end);
  return /i32\.atomic\.rmw\.cmpxchg/.test(body) && /\(i32\.const 10\)/.test(body);
}

function findMallocLockWordAddress(text) {
  const inMalloc = constantCalls(functionBody(text, '_malloc'));
  const inFree = constantCalls(functionBody(text, '_free'));
  const candidates = [];
  inMalloc.forEach(function(pair, key) {
    if (inFree.has(key) && pair.address % 4 === 0 && looksLikeMutexLock(text, pair.callee)) candidates.push(pair);
  });
  if (candidates.length !== 1) {
    throw new Error('expected exactly one mutex that malloc and free both lock, found ' + candidates.length +
      (candidates.length ? ': ' + candidates.map(function(c) { return c.address; }).join(', ') : ''));
  }
  // pthread_mutex_t is { _m_type, _m_lock, _m_waiters, ... }: the lock word is the second one
  return candidates[0].address + 4;
}

module.exports = { findMallocLockWordAddress };

if (require.main === module) {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) {
    console.error('usage: node find-malloc-lock.js <module.wat> <output .js>');
    process.exit(2);
  }
  try {
    const address = findMallocLockWordAddress(fs.readFileSync(input, 'utf8'));
    fs.writeFileSync(output, '// Written by tools/find-malloc-lock.js from the linked module\nvar MALLOC_LOCK_WORD_ADDRESS = ' + address + ';\n');
    console.log('the lock word of the allocator is at ' + address);
  } catch (error) {
    console.error('cannot find the lock of the allocator: ' + error.message);
    process.exit(1);
  }
}
