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
assert.doesNotMatch(
  listener,
  /ClConnectionTerminated[\s\S]*LiStopConnection\(\)/,
);
assert.match(listener, /StopConnection\(errorCode\)/);
assert.match(input, /m_MouseDeltaX\.exchange\(0\)/);

console.log('connection_wiring_tests: PASS');
