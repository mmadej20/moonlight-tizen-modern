'use strict';

// Checks on the TV whether the UDP receive writes only as many bytes as it was asked for (wasm/udp_recv_probe.hpp). For
// every case it starts one receive on a worker thread of the application, sends a datagram of a given length from this
// computer, and prints the report of the probe. Needs a build with the diagnostic probes (--build-arg ALLOC_STRESS=ON)
// running in debug mode.
//
// Usage: node udp_probe_run.js <host:port/devtools/page/ID> <tv address> [port=47777]
const dgram = require('dgram');

const [target, tvAddress, portArg] = process.argv.slice(2);
const port = Number(portArg || 47777);
if (!target || !tvAddress) {
  console.log('usage: node udp_probe_run.js <host:port/devtools/page/ID> <tv address> [port]');
  process.exit(2);
}

// What the sender puts in its datagrams: the same bytes as PayloadByte() of the probe
function payload(size) {
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    const value = (i * 7 + 3) & 0xff;
    data[i] = value === 0xa5 ? 0xa6 : value;
  }
  return data;
}

// bufferLength, datagram sizes: shorter, equal, one byte longer, a little longer, much longer, the size of a video packet
const CASES = [
  { bufferLength: 512, sizes: [100, 512, 513, 528, 700, 1400] },
  { bufferLength: 1408, sizes: [1392, 1408, 1409, 1472] },
];

const REPORT = '(function(){var p=Module.udpProbeReportPointer();var s="";for(var i=0;HEAPU8[p+i];i++)s+=String.fromCharCode(HEAPU8[p+i]);return s;})()';

const ws = new WebSocket('ws://' + target);
let nextId = 0;
const pending = new Map();
function send(method, params, timeoutMs) {
  return new Promise((resolve) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, timeoutMs || 8000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true });
  return response.result && response.result.result ? response.result.result.value : undefined;
}
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
};
ws.onerror = () => { console.log('websocket error'); process.exit(1); };

const socket = dgram.createSocket('udp4');
function sendDatagram(size) {
  return new Promise((resolve) => socket.send(payload(size), port, tvAddress, () => resolve()));
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ws.onopen = async () => {
  await send('Runtime.enable');
  const present = await evaluate('typeof Module.udpProbeStart');
  if (present !== 'function') { console.log('this build has no UDP probe (build with --build-arg ALLOC_STRESS=ON)'); process.exit(2); }
  let bad = 0;
  for (const testCase of CASES) {
    for (const withAddress of [0, 1]) {
      for (const size of testCase.sizes) {
        const started = await evaluate('Module.udpProbeStart(' + [port, testCase.bufferLength, 4000, withAddress].join(',') + ')');
        if (started !== 1) { console.log('could not start the probe: ' + started); process.exit(1); }
        await sleep(400);
        await sendDatagram(size);
        let line = '';
        for (let i = 0; i < 30; i++) {
          await sleep(150);
          line = await evaluate(REPORT);
          if (/state=done/.test(line)) break;
        }
        const wrong = /WRITES_OUTSIDE_THE_BUFFER|NOTHING_RECEIVED/.test(line) || !/state=done/.test(line);
        if (wrong) bad++;
        console.log('buffer=' + testCase.bufferLength + ' sent=' + size + ' ' + line + (wrong ? '   <== PROBLEM' : ''));
      }
    }
  }
  console.log(bad ? 'PROBE FOUND ' + bad + ' PROBLEM CASE(S)' : 'PROBE: the receive stays inside its buffer in every case');
  process.exit(bad ? 1 : 0);
};
