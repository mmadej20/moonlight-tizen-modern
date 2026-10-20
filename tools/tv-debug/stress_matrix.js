// Runs the allocator stress test in several variants, each in a freshly launched application, and sums up what happened.
// Usage: node stress_matrix.js <log dir> <seconds per variant> [variant name ...]
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const [logDir, secondsArg, ...only] = process.argv.slice(2);
const seconds = Number(secondsArg || 120);
const TV = process.env.TV_IP;
if (!TV) { console.error('set TV_IP to the address of the TV'); process.exit(2); }
// Docker image that contains the Tizen SDK (docker build --target sdk -t mt-sdk-probe .); sdb runs inside it
const SDK_IMAGE = process.env.SDK_IMAGE || 'mt-sdk-probe';

// Paced: the threads sleep pauseMicros after every pauseEvery iterations (12 threads without pauses froze the TV)
const variants = [
  { name: 'light3-all', threads: 3, modes: 31, pauseEvery: 8, pauseMicros: 500 },
  { name: 'light3-mutex', threads: 3, modes: 1, pauseEvery: 8, pauseMicros: 500 },
  { name: 'light3-atomic-spin', threads: 3, modes: 6, pauseEvery: 8, pauseMicros: 500 },
  { name: 'light3-malloc', threads: 3, modes: 24, pauseEvery: 8, pauseMicros: 500 },
  { name: 'medium4-all', threads: 4, modes: 31, pauseEvery: 8, pauseMicros: 150 },
].filter((v) => only.length === 0 || only.includes(v.name));

const summaryFile = path.join(logDir, 'alloc-stress-matrix.log');
function say(text) {
  const line = new Date().toISOString() + ' ' + text;
  fs.appendFileSync(summaryFile, line + '\n');
  console.log(line);
}

function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout), stderr: String(stderr) }));
  });
}

async function launchDebug() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const sdb = '/home/moonlight/tizen-studio/tools/sdb; ';
    const script = 'S=' + sdb + '$S connect ' + TV + ' >/dev/null; timeout 50 $S -s ' + TV + ':26101 shell 0 debug MoonLightS.MoonlightWasm 2>&1';
    const result = await run('docker', ['run', '--rm', SDK_IMAGE, 'bash', '-lc', script], 90000);
    const match = /port: (\d+)/.exec(result.stdout);
    if (match) return match[1];
    say('debug launch attempt ' + attempt + ' gave no port: ' + (result.stdout + result.stderr).trim().slice(0, 200));
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  return null;
}

async function inspectorTarget(port) {
  for (let i = 0; i < 20; i++) {
    try {
      const response = await fetch('http://' + TV + ':' + port + '/json');
      const list = await response.json();
      if (list[0] && list[0].webSocketDebuggerUrl) return list[0].webSocketDebuggerUrl.replace(/^ws:\/\//, '');
    } catch (error) { /* the page is not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return null;
}

function runStress(variant, target, logFile) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, 'alloc_stress_run.js'), target, logFile, String(variant.threads), String(seconds), String(variant.modes), '128', String(variant.pauseEvery), String(variant.pauseMicros)],
      { env: Object.assign({}, process.env, { EXIT_AFTER: '1' }) });
    child.stdout.on('data', () => {});
    child.on('exit', (code) => resolve({ code, elapsedS: Math.round((Date.now() - started) / 1000) }));
  });
}

(async () => {
  say('matrix start: ' + variants.map((v) => v.name).join(', ') + ', ' + seconds + ' s each');
  for (const variant of variants) {
    const logFile = path.join(logDir, 'alloc-stress-' + variant.name + '.log');
    const port = await launchDebug();
    if (!port) { say(variant.name + ': could not launch the application'); continue; }
    const target = await inspectorTarget(port);
    if (!target) { say(variant.name + ': no inspector target on port ' + port); continue; }
    say(variant.name + ': running on port ' + port + ' (threads=' + variant.threads + ' modes=' + variant.modes + ')');
    const result = await runStress(variant, target, logFile);
    const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : [];
    const reports = lines.filter((l) => / report \(/.test(l));
    const lastReport = reports.length ? reports[reports.length - 1].replace(/^\S+ report /, '') : '(no report)';
    const verdict = { 0: 'FINISHED', 2: 'NO STRESS BUILD', 3: 'APPLICATION DIED', 4: 'MAIN THREAD FROZEN', 5: 'ABORTED, MAIN THREAD TOO SLOW', 1: 'RUNNER ERROR' }[result.code] || ('exit ' + result.code);
    say(variant.name + ': ' + verdict + ' after ' + result.elapsedS + ' s; last report: ' + lastReport);
    await new Promise((resolve) => setTimeout(resolve, 12000));
  }
  say('matrix done');
})();
