// Evaluates a JavaScript expression in the main page of the application on the TV and prints the answer.
// Usage: node page_eval.js <host:port/devtools/page/ID> <expression file> [timeout ms]
// The expression may return a promise; the answer is returned by value. Read-only use: it does not pause the page.
'use strict';

const fs = require('fs');

const [target, expressionFile, timeoutArg] = process.argv.slice(2);
if (!target || !expressionFile) {
  console.error('usage: node page_eval.js <host:port/devtools/page/ID> <expression file> [timeout ms]');
  process.exit(2);
}

const expression = fs.readFileSync(expressionFile, 'utf8');
const timeoutMs = Number(timeoutArg || 20000);
const socket = new WebSocket('ws://' + target);
const timer = setTimeout(() => {
  console.error('no answer within ' + timeoutMs + ' ms');
  process.exit(1);
}, timeoutMs);

socket.onopen = () => {
  socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs - 2000 }
  }));
};
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== 1) return;
  clearTimeout(timer);
  const result = message.result && message.result.result;
  if (message.result && message.result.exceptionDetails) {
    console.log('exception: ' + JSON.stringify(message.result.exceptionDetails.exception || message.result.exceptionDetails));
  } else {
    console.log(result && 'value' in result ? result.value : JSON.stringify(result));
  }
  socket.close();
  process.exit(0);
};
socket.onerror = (error) => {
  console.error('websocket error: ' + (error.message || error));
  process.exit(1);
};
