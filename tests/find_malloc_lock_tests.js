'use strict';

const assert = require('assert');
const { findMallocLockWordAddress } = require('../tools/find-malloc-lock.js');

// A disassembly of a module in the shape that wasm-dis writes it: pthread_mutex_lock stores EBUSY (10) with a
// compare and swap, malloc locks the mutex of the allocator (1000) at its start and the global mutex (2000) on some
// paths, free locks only the mutex of the allocator.
function disassembly(options) {
  options = options || {};
  const lockCall = (address) => ' (call $lock\n  (i32.const ' + address + ')\n )\n';
  return [
    '(module',
    ' (export "_malloc" (func $m))',
    ' (export "_free" (func $f))',
    ' (func $lock (; 7 ;) (type $1) (param $0 i32) (result i32)',
    '  (if (i32.eqz (i32.atomic.rmw.cmpxchg (i32.add (local.get $0) (i32.const 4)) (i32.const 0) (i32.const 10)))',
    '   (return (i32.const 0)))',
    '  (i32.const 1)',
    ' )',
    ' (func $trylike (; 8 ;) (type $1) (param $0 i32) (result i32)',
    '  (i32.add (local.get $0) (i32.const 1))',
    ' )',
    ' (func $m (; 9 ;) (type $1) (param $0 i32) (result i32)',
    lockCall(1000),
    lockCall(2000),
    ' (call $trylike\n  (i32.const 3000)\n )',
    ' )',
    ' (func $f (; 10 ;) (type $2) (param $0 i32)',
    lockCall(1000),
    options.freeAlsoLocksGlobal ? lockCall(2000) : '',
    ' (call $trylike\n  (i32.const 3000)\n )',
    ' )',
    ' (func $other (; 11 ;) (type $2) (param $0 i32)',
    lockCall(5000),
    ' )',
    ')',
    ''
  ].join('\n');
}

// The mutex that malloc and free both lock is the one of the allocator, and the lock word is its second word
assert.strictEqual(findMallocLockWordAddress(disassembly()), 1004);

// The same with the whitespace of the CRLF files of a Windows checkout
assert.strictEqual(findMallocLockWordAddress(disassembly().replace(/\n/g, '\r\n')), 1004);

// A second mutex that both lock cannot be told apart: the build must fail, not guess
assert.throws(() => findMallocLockWordAddress(disassembly({ freeAlsoLocksGlobal: true })), /found 2: /);

// A module without the exports, or whose allocator never locks, is an error too
assert.throws(() => findMallocLockWordAddress('(module)'), /export _malloc not found/);
assert.throws(
  () => findMallocLockWordAddress(disassembly().replace(/\(i32\.atomic\.rmw\.cmpxchg/g, '(i32.rmw.nothing')),
  /found 0/);

console.log('find malloc lock tests passed');
