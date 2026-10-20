// Starts the allocator stress test inside the debuggable Moonlight, follows its report and walks the heap at the end.
// Only the page is attached (no debugger on the workers), so the timing of the test is not disturbed.
// Usage: node alloc_stress_run.js <host:port/devtools/page/ID> <log file> [threads=3] [seconds=600] [modes=31] [liveBlocks=128]
//                                 [pauseEvery=8] [pauseMicros=500]
// The test is stopped when the main thread answers slowly: a first version with 12 unpaused threads made the whole TV lag.
const fs = require('fs');
const walkerSource = require('./heap_walker.js');

const [target, logFile, threadsArg, secondsArg, modesArg, liveArg, pauseEveryArg, pauseMicrosArg] = process.argv.slice(2);
const threads = Number(threadsArg || 3);
const seconds = Number(secondsArg || 600);
const modes = Number(modesArg || 31);
const liveBlocks = Number(liveArg || 128);
const pauseEvery = Number(pauseEveryArg || 8);
const pauseMicros = Number(pauseMicrosArg || 500);
const POLL_MS = 5000;
const UNRESPONSIVE_MS = 12000;
const SLOW_ANSWER_MS = 2500;

const out = fs.createWriteStream(logFile, { flags: 'a' });
function log(text) {
  const line = new Date().toISOString() + ' ' + text;
  out.write(line + '\n');
  console.log(line);
}

let nextId = 0;
const pending = new Map();
let ws;

function send(method, params, timeoutMs) {
  return new Promise((resolve) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, timeoutMs || 8000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    try { ws.send(JSON.stringify({ id, method, params: params || {} })); } catch (error) { clearTimeout(timer); pending.delete(id); resolve({ error: String(error) }); }
  });
}

async function evaluate(expression, timeoutMs) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true }, timeoutMs);
  if (response.timeout) return { timeout: true };
  const result = response.result && response.result.result;
  if (response.result && response.result.exceptionDetails) return { error: JSON.stringify(response.result.exceptionDetails).slice(0, 400) };
  return { value: result && result.value };
}

const REPORT = '(function(){var p=Module.allocStressReportPointer();var s="";for(var i=0;HEAPU8[p+i];i++)s+=String.fromCharCode(HEAPU8[p+i]);return s;})()';

async function main() {
  ws = new WebSocket('ws://' + target);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('websocket error')); });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  ws.onclose = () => { log('WEBSOCKET CLOSED (the application was closed or killed)'); process.exit(3); };
  await send('Runtime.enable');

  // The module loads after the page opens: wait for the embind functions to appear before deciding there is none
  let present = await evaluate('typeof Module.allocStressStart');
  for (let i = 0; i < 30 && present.value !== 'function'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    present = await evaluate('typeof Module !== "undefined" ? typeof Module.allocStressStart : "no Module"');
  }
  log('allocStressStart is ' + JSON.stringify(present));
  if (present.value !== 'function') { log('this build has no stress test'); process.exit(2); }

  const started = await evaluate('Module.allocStressStart(' + [threads, seconds, modes, liveBlocks, pauseEvery, pauseMicros].join(',') + ')');
  log('start(threads=' + threads + ' seconds=' + seconds + ' modes=' + modes + ' liveBlocks=' + liveBlocks +
    ' pauseEvery=' + pauseEvery + ' pauseMicros=' + pauseMicros + ') -> ' + JSON.stringify(started));

  let lastAnswer = Date.now();
  let last = '';
  let slowAnswers = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const asked = Date.now();
    const report = await evaluate(REPORT, UNRESPONSIVE_MS);
    const latency = Date.now() - asked;
    if (!report.timeout && !report.error) {
      slowAnswers = latency > SLOW_ANSWER_MS ? slowAnswers + 1 : 0;
      if (slowAnswers >= 2) {
        log('ABORTED: the main thread needed ' + latency + ' ms to answer, twice in a row. Stopping the test to protect the TV');
        await evaluate('Module.allocStressStop()', 8000);
        log('last report before the abort: ' + report.value);
        process.exit(5);
      }
    }
    if (report.timeout || report.error) {
      log('NO ANSWER from the main thread for ' + (Date.now() - lastAnswer) + ' ms (' + (report.error || 'timeout') + ')');
      if (Date.now() - lastAnswer > UNRESPONSIVE_MS) {
        log('MAIN THREAD FROZEN while the stress test runs. Last report: ' + last);
        log('leaving the application as it is; attach the forensic watcher now');
        process.exit(4);
      }
      continue;
    }
    lastAnswer = Date.now();
    last = report.value;
    log('report (' + latency + ' ms to answer) ' + report.value);
    if (/state=finished/.test(report.value)) break;
    if (/maxIdleMs=(\d+)/.test(report.value) && Number(/maxIdleMs=(\d+)/.exec(report.value)[1]) > 8000) {
      log('A WORKER HAS MADE NO PROGRESS FOR MORE THAN 8 s: probable deadlock in the allocator or a lock');
    }
  }

  await evaluate('globalThis.__heapWalk = ' + walkerSource + '; 0');
  const walk = await evaluate('JSON.stringify(__heapWalk({ maxMs: 5000 }))', 20000);
  log('heap walk after the test: ' + (walk.value || JSON.stringify(walk)).slice(0, 2500));
  const finalReport = await evaluate(REPORT);
  log('FINAL ' + finalReport.value);
  if (process.env.EXIT_AFTER === '1') {
    // So that the next run starts a fresh application: the page asks Tizen to close it
    ws.onclose = null;
    await evaluate('tizen.application.getCurrentApplication().exit()', 4000);
    log('asked the application to exit');
  }
  process.exit(0);
}

main().catch((error) => { log('runner error ' + error); process.exit(1); });
