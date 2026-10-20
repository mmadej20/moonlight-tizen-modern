// Sends the same expression to a list of threads of a running forensics.js (one command at a time) and prints the answers.
// Usage: node run_cmds.js <log file> <command file> <expression file> <thread prefix> [<thread prefix> ...]
const fs = require('fs');
const [logFile, cmdFile, expressionFile, ...threads] = process.argv.slice(2);
const expression = fs.readFileSync(expressionFile, 'utf8').trim();

async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

(async () => {
  for (const thread of threads) {
    const before = fs.readFileSync(logFile, 'utf8').length;
    fs.writeFileSync(cmdFile, JSON.stringify({ thread, expression, timeoutMs: 8000 }));
    let answer = null;
    for (let i = 0; i < 40 && !answer; i++) {
      await sleep(500);
      const text = fs.readFileSync(logFile, 'utf8').slice(before);
      const at = text.indexOf('[cmd ' + thread + ']');
      if (at >= 0) {
        const rest = text.slice(at).split('\n');
        answer = rest.slice(1, 3).join(' ').trim();
        if (!answer) answer = null;
      }
    }
    console.log(thread + ': ' + (answer || '(no answer)'));
  }
})();
