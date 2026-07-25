const assert = require('assert');
const fs = require('fs');
const path = require('path');

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

function withDeadline(promise, label) {
  let timeoutId;
  const deadline = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} did not settle`)), 1000);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeoutId));
}

function createFakeTimers() {
  const timers = new Map();
  let nextId = 1;

  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pendingCount() {
      return timers.size;
    },
    pendingDelays() {
      return Array.from(timers.values()).map((timer) => timer.delay);
    },
    fireAll() {
      const pending = Array.from(timers.entries());
      pending.forEach(([id]) => timers.delete(id));
      pending.forEach(([, timer]) => timer.callback());
    },
  };
}

function createFakeAbortController() {
  function FakeAbortController() {
    const listeners = [];
    this.aborted = false;
    this.signal = {
      controller: this,
      addEventListener(type, listener) {
        if (type === 'abort') {
          listeners.push(listener);
        }
      },
    };
    this.abort = () => {
      if (this.aborted) {
        return;
      }
      this.aborted = true;
      listeners.slice().forEach((listener) => listener());
    };
  }

  return FakeAbortController;
}

function createDeferredFetch(options) {
  const pending = [];
  const controllers = [];
  const abortSettles = !options || options.abortSettles !== false;
  let active = 0;
  let maximumActive = 0;
  let calls = 0;

  function remove(record) {
    if (record.settled) {
      return;
    }
    record.settled = true;
    active -= 1;
  }

  function fakeFetch(url, requestOptions) {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const controller = requestOptions && requestOptions.signal && requestOptions.signal.controller;
    const record = { url, controller, settled: false, resolve: null, reject: null };
    if (controller) {
      controllers.push(controller);
    }

    const promise = new Promise((resolve, reject) => {
      record.resolve = (response) => {
        remove(record);
        resolve(response);
      };
      record.reject = (error) => {
        remove(record);
        reject(error);
      };
    });
    pending.push(record);

    if (requestOptions && requestOptions.signal) {
      requestOptions.signal.addEventListener('abort', () => {
        if (abortSettles) {
          record.reject({ name: 'AbortError' });
        }
      });
    }

    return promise;
  }

  return {
    fakeFetch,
    controllers,
    get active() { return active; },
    get maximumActive() { return maximumActive; },
    get calls() { return calls; },
    activeControllers() {
      return pending.filter((item) => !item.settled).map((item) => item.controller);
    },
    resolveNext(response) {
      const record = pending.find((item) => !item.settled);
      assert(record, 'a deferred probe must be pending');
      record.resolve(response);
      return record;
    },
    rejectNext(error) {
      const record = pending.find((item) => !item.settled);
      assert(record, 'a deferred probe must be pending');
      record.reject(error);
      return record;
    },
    resolveAll(responseForUrl) {
      pending.filter((item) => !item.settled).forEach((record) => {
        record.resolve(responseForUrl(record.url));
      });
    },
  };
}

async function settleAll(fakeFetch, responseForUrl) {
  while (fakeFetch.active > 0) {
    fakeFetch.resolveAll(responseForUrl);
    await flushMicrotasks();
  }
}

function createScanner(fakeFetch, fakeTimers, FakeAbortController, found, overrides) {
  const { createSubnetScanner } = require('../wasm/static/js/mdns-browser/subnet_scanner.js');
  return createSubnetScanner(Object.assign({
    fetch: fakeFetch.fakeFetch,
    onFound: (ip) => found.push(ip),
    concurrency: 8,
    AbortController: FakeAbortController,
    setTimeout: fakeTimers.setTimeout,
    clearTimeout: fakeTimers.clearTimeout,
  }, overrides));
}

async function run() {
  const FakeAbortController = createFakeAbortController();
  const fakeTimers = createFakeTimers();
  const fakeFetch = createDeferredFetch();
  const found = [];
  const scanner = createScanner(fakeFetch, fakeTimers, FakeAbortController, found);
  const source = fs.readFileSync(path.join(__dirname, '../wasm/static/js/mdns-browser/main.js'), 'utf8');
  assert.strictEqual(source.includes('for (var i = 1; i <= 254; i++)'), false,
    'main.js must not retain the old 1..254 fan-out loop');

  const firstScan = scanner.start('192.168.1');
  assert.strictEqual(fakeFetch.active, 8, 'the scan starts exactly eight probes');
  assert.strictEqual(fakeFetch.maximumActive, 8, 'the scan never exceeds eight active probes');
  fakeFetch.resolveNext({ ok: false });
  await flushMicrotasks();
  assert.strictEqual(fakeFetch.active, 8, 'a completed probe is replaced by exactly one queued probe');
  assert.strictEqual(fakeFetch.maximumActive, 8, 'steady-state concurrency remains bounded at eight');

  const controllersAtCancel = fakeFetch.activeControllers();
  scanner.cancel();
  assert.strictEqual(controllersAtCancel.every((controller) => controller.aborted), true,
    'cancelling aborts every active probe controller');
  assert.strictEqual(fakeFetch.active, 0, 'cancelling settles every active fake fetch');
  await withDeadline(firstScan, 'cancelled first scan');
  assert.deepStrictEqual(found, [], 'cancelled probes never report found hosts');
  assert.strictEqual(fakeTimers.pendingCount(), 0, 'cancelling clears every active per-probe timeout');

  for (const concurrencyCase of [
    { value: 9, expected: 8 },
    { value: 8.5, expected: 8 },
    { value: Infinity, expected: 8 },
    { value: -1, expected: 8 },
    { value: 0, expected: 8 },
    { value: NaN, expected: 8 },
    { value: 'invalid', expected: 8 },
    { value: 3, expected: 3 },
  ]) {
    const boundedTimers = createFakeTimers();
    const boundedFetch = createDeferredFetch();
    const boundedScanner = createScanner(
      boundedFetch,
      boundedTimers,
      FakeAbortController,
      [],
      { concurrency: concurrencyCase.value },
    );
    const boundedScan = boundedScanner.start('172.16.0');
    assert.strictEqual(
      boundedFetch.active,
      concurrencyCase.expected,
      `concurrency ${String(concurrencyCase.value)} normalizes safely`,
    );
    assert(
      boundedFetch.maximumActive <= 8,
      `concurrency ${String(concurrencyCase.value)} never exceeds the hard cap`,
    );
    boundedScanner.cancel();
    await withDeadline(boundedScan, `cancelled concurrency ${String(concurrencyCase.value)} scan`);
  }

  const timeoutTimers = createFakeTimers();
  const timeoutFetch = createDeferredFetch();
  const timeoutScanner = createScanner(
    timeoutFetch,
    timeoutTimers,
    FakeAbortController,
    [],
    { timeoutMs: 1 },
  );
  const timeoutScan = timeoutScanner.start('192.168.2');
  assert.deepStrictEqual(
    timeoutTimers.pendingDelays(),
    new Array(8).fill(3000),
    'every probe uses the required 3000 ms timeout even when the caller supplies an override',
  );
  const firstTimedControllers = timeoutFetch.activeControllers();
  while (timeoutFetch.calls < 254 || timeoutFetch.active > 0) {
    timeoutTimers.fireAll();
    await flushMicrotasks();
  }
  await withDeadline(timeoutScan, 'timeout-driven scan');
  assert.strictEqual(
    firstTimedControllers.every((controller) => controller.aborted),
    true,
    'firing the per-probe timeout aborts every active controller',
  );
  assert.strictEqual(timeoutFetch.calls, 254, 'timed-out probes do not stop worker progress');
  assert.strictEqual(timeoutTimers.pendingCount(), 0, 'the timeout-driven scan settles without leftover timers');

  const successTimers = createFakeTimers();
  const successFetch = createDeferredFetch();
  const successFound = [];
  const successScanner = createScanner(successFetch, successTimers, FakeAbortController, successFound);
  const successScan = successScanner.start('192.168.1');
  successFetch.rejectNext(new Error('network failure'));
  await flushMicrotasks();
  await settleAll(successFetch, (url) => ({ ok: /192\.168\.1\.42:47989\/serverinfo$/.test(url) }));
  await withDeadline(successScan, 'successful scan');
  assert.deepStrictEqual(successFound, ['192.168.1.42'], 'the one successful server probe reports its IP once');
  assert.strictEqual(successFetch.calls, 254, 'a completed scan probes every usable /24 address');
  assert.strictEqual(successTimers.pendingCount(), 0, 'completed probes clear their per-probe timeouts');

  const throwingFoundTimers = createFakeTimers();
  const throwingFoundFetch = createDeferredFetch();
  const throwingFound = [];
  const throwingFoundScanner = createScanner(
    throwingFoundFetch,
    throwingFoundTimers,
    FakeAbortController,
    [],
    {
      onFound(ip) {
        throwingFound.push(ip);
        if (ip === '192.168.3.1') {
          throw new Error('consumer callback failed');
        }
      },
    },
  );
  const throwingFoundScan = throwingFoundScanner.start('192.168.3');
  await settleAll(throwingFoundFetch, (url) => ({
    ok: /192\.168\.3\.(?:1|42):47989\/serverinfo$/.test(url),
  }));
  await withDeadline(throwingFoundScan, 'throwing onFound scan');
  assert.deepStrictEqual(
    throwingFound,
    ['192.168.3.1', '192.168.3.42'],
    'a throwing onFound callback does not stop later probes or callbacks',
  );
  assert.strictEqual(throwingFoundFetch.calls, 254, 'a throwing callback does not stop the worker pool');

  const bodyTimers = createFakeTimers();
  const bodyFetch = createDeferredFetch();
  const bodyFound = [];
  const cancelledBodies = [];
  const bodyScanner = createScanner(bodyFetch, bodyTimers, FakeAbortController, bodyFound);
  const bodyScan = bodyScanner.start('192.168.4');
  await settleAll(bodyFetch, (url) => {
    const address = Number(url.match(/192\.168\.4\.(\d+):47989/)[1]);
    return {
      ok: address === 42,
      body: {
        cancel() {
          cancelledBodies.push(address);
          if (address === 1) {
            throw new Error('synchronous body cancellation failure');
          }
          if (address === 2) {
            return Promise.reject(new Error('asynchronous body cancellation failure'));
          }
          return Promise.resolve();
        },
      },
    };
  });
  await withDeadline(bodyScan, 'response body cleanup scan');
  assert.strictEqual(cancelledBodies.length, 254, 'every unused success and non-ok response body is cancelled');
  assert.deepStrictEqual(bodyFound, ['192.168.4.42'], 'body cleanup failures do not suppress discovery');
  assert.strictEqual(bodyFetch.calls, 254, 'body cleanup failures do not stop worker progress');
  assert.strictEqual(bodyTimers.pendingCount(), 0, 'body cleanup leaves no per-probe timers behind');

  const hangingBodyTimers = createFakeTimers();
  const hangingBodyFetch = createDeferredFetch();
  const hangingBodyCancellations = [];
  const neverSettles = new Promise(() => {});
  const hangingBodyScanner = createScanner(
    hangingBodyFetch,
    hangingBodyTimers,
    FakeAbortController,
    [],
  );
  const hangingBodyScan = hangingBodyScanner.start('192.168.5');
  await settleAll(hangingBodyFetch, (url) => ({
    ok: false,
    body: {
      cancel() {
        hangingBodyCancellations.push(url);
        return neverSettles;
      },
    },
  }));
  await withDeadline(hangingBodyScan, 'never-settling response body cleanup scan');
  assert.strictEqual(hangingBodyFetch.calls, 254,
    'never-settling body cancellation does not stop worker progress');
  assert.strictEqual(hangingBodyCancellations.length, 254,
    'body cancellation is still initiated for every response when its promise never settles');
  assert.strictEqual(hangingBodyTimers.pendingCount(), 0,
    'never-settling body cancellation does not leave probe timers behind');

  const restartTimers = createFakeTimers();
  const restartFetch = createDeferredFetch({ abortSettles: false });
  const restartFound = [];
  const restartScanner = createScanner(restartFetch, restartTimers, FakeAbortController, restartFound);
  const staleScan = restartScanner.start('10.0.0');
  const staleControllers = restartFetch.activeControllers();
  const currentScan = restartScanner.start('10.0.1');
  assert.strictEqual(staleControllers.every((controller) => controller.aborted), true,
    'starting a scan cancels the previous generation');
  restartFetch.resolveAll((url) => ({ ok: /10\.0\.0\./.test(url) }));
  await flushMicrotasks();
  assert.deepStrictEqual(restartFound, [], 'late successful responses from a stale generation never call onFound');
  await settleAll(restartFetch, (url) => ({ ok: /10\.0\.1\.42:47989\/serverinfo$/.test(url) }));
  await withDeadline(Promise.all([staleScan, currentScan]), 'restarted scans');
  assert.deepStrictEqual(restartFound, ['10.0.1.42'], 'the restarted generation remains isolated from stale results');
  assert.strictEqual(restartTimers.pendingCount(), 0, 'restart cleanup leaves no probe timers behind');

  console.log('subnet_scanner_tests: PASS');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
