'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'wasm', 'main.cpp'), 'utf8');
const listener = fs.readFileSync(
  path.join(root, 'wasm', 'connectionlistener.cpp'),
  'utf8',
);
const input = fs.readFileSync(path.join(root, 'wasm', 'input.cpp'), 'utf8');

assert.match(main, /LiInterruptConnection\(\)/);
assert.match(main, /m_ConnectionLifecycle\.AcquireStartGuard\(\)/);
assert.match(
  main,
  /m_ConnectionThread\.Create\(MoonlightInstance::ConnectionThreadFunc,\s*this\)/,
);
assert.match(
  main,
  /m_InputThread\.Create\(MoonlightInstance::InputThreadFunc,\s*me\)/,
);
assert.match(
  main,
  /m_StopThread\.Create\(MoonlightInstance::StopThreadFunc,\s*this\)/,
);
assert.match(main, /m_ConnectionThread\.Join\(\)/);
assert.match(main, /m_InputThread\.Join\(\)/);
assert.match(main, /m_StopThread\.Join\(\)/);
assert.doesNotMatch(main, /pthread_create\(/);
assert.doesNotMatch(main, /pthread_join\(/);
assert.match(main, /m_TerminationReported\.exchange/);
// Teardown always reports the end of the stream and returns to idle, even when a thread cannot be joined.
assert.match(main, /RunStopSequence\(sequence\)/);
assert.match(main, /sequence\.markIdle\s*=/);
assert.match(main, /m_ConnectionLifecycle\.AbortStart\(\)/);
assert.doesNotMatch(
  main,
  /startGuard\.Release\(\);\s*m_ConnectionLifecycle\.BeginStop\(\);/,
  'a start that fails before creating threads must not enter the stopping state without a stop thread',
);
assert.doesNotMatch(
  listener,
  /ClConnectionTerminated[\s\S]*LiStopConnection\(\)/,
);
assert.match(listener, /StopConnection\(errorCode\)/);
assert.match(input, /m_MouseDeltaX\.exchange\(0\)/);

console.log('connection_wiring_tests: PASS');
