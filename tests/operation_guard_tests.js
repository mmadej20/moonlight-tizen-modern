const assert = require('assert');
const guards = require('../wasm/platform/operation_guard.js');

const gate = guards.createGenerationGate();
const first = gate.begin();
assert(gate.isCurrent(first));
const second = gate.begin();
assert(!gate.isCurrent(first));
assert(gate.isCurrent(second));
gate.cancel();
assert(!gate.isCurrent(second));

const errors = [];
assert.strictEqual(guards.parseStoredJson(null, errors.push.bind(errors)), null);
assert.deepStrictEqual(guards.parseStoredJson('{"a":1}', errors.push.bind(errors)), { a: 1 });
assert.strictEqual(guards.parseStoredJson('{bad', errors.push.bind(errors)), null);
assert.strictEqual(errors.length, 1);
assert.doesNotThrow(() => {
  assert.strictEqual(guards.parseStoredJson('{bad', function() {
    throw new Error('logger failed');
  }), null);
});

console.log('operation_guard_tests: PASS');
