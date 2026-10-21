'use strict';

// A stream start spends about 3 s in the server info request before the launch request, and the logs cannot say whether
// that is the TLS handshake on the TV or the host. Requests that take a second or more now log the stages that curl
// measured: name lookup, connect, TLS, wait for the host, transfer.

const assert = require('assert');
const fs = require('fs');

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function extractBraced(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, 'Missing ' + marker);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(source.indexOf('{', start) + 1, index);
    }
  }
  throw new Error('Unbalanced braces after ' + marker);
}

const httpC = read('libgamestream/http.c');
const httpCpp = read('wasm/http.cpp');
const header = read('wasm/moonlight_wasm.hpp');

// curl is asked for the times right after the request has run, on success and on failure.
const request = extractBraced(httpC, 'int http_request(');
const performAt = request.indexOf('curl_easy_perform(curl)');
assert(performAt >= 0);
const afterPerform = request.slice(performAt, request.indexOf('printf("CURL request completed'));
for (const info of ['CURLINFO_NAMELOOKUP_TIME', 'CURLINFO_CONNECT_TIME', 'CURLINFO_APPCONNECT_TIME',
  'CURLINFO_STARTTRANSFER_TIME', 'CURLINFO_TOTAL_TIME']) {
  assert(afterPerform.includes(info), info + ' is read right after the request');
}
assert(/context->timing_valid = 1;/.test(afterPerform), 'the timing is marked valid only after it was read');
assert(/timing_total_ms = /.test(afterPerform) && /\* 1000\.0/.test(afterPerform), 'curl seconds are stored as milliseconds');

// The native side writes the line for slow requests and never logs the host or the query string.
assert(/#include "http_timing\.hpp"/.test(header));
const open = extractBraced(httpCpp, 'void MoonlightInstance::OpenUrl_private(');
const call = open.indexOf('http_request(url.c_str()');
const logAt = open.indexOf('ShouldLogHttpTiming(requestContext->timing_total_ms)');
assert(call >= 0 && logAt > call, 'the timing is logged after the request ran');
assert(logAt < open.indexOf('if (err) {'), 'also when the request failed');
assert(/HttpUrlPathForLog\(url\)/.test(open.slice(logAt, logAt + 400)), 'only the path is logged');
assert(/requestContext->timing_valid/.test(open.slice(logAt - 200, logAt + 50)), 'only a measured timing is logged');
assert(/DescribeHttpTiming\(/.test(open.slice(logAt, logAt + 600)));

// The connect limit follows the total limit, and curl's own text of an error is logged with the error.
assert(/m_HttpRequests\.Create\(callbackId, HttpConnectTimeoutMs\(timeoutMs\), timeoutMs\)/.test(httpCpp));
assert(!/m_HttpRequests\.Create\(callbackId, 3000,/.test(httpCpp), 'no fixed limit is left');
assert(/curl_easy_setopt\(curl, CURLOPT_ERRORBUFFER, curl_error\);/.test(request));
assert(/printf\("CURL request completed: %s%s%s\\n", curl_easy_strerror\(res\), [^;]*curl_error\);/.test(request));

console.log('http timing wiring tests passed');
