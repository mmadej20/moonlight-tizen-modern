const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const OperationGuard = require('../wasm/platform/operation_guard.js');

const indexSource = fs.readFileSync('wasm/platform/index.js', 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, 'Missing function ' + name);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = bodyStart; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }
    if (current === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === '\'' || current === '"' || current === '`') {
      quote = current;
      continue;
    }
    if (current === '{') depth += 1;
    if (current === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('Unterminated function ' + name);
}

function loadFunctions(names, context) {
  if (!context.t) {
    context.t = function(template) {
      const values = Array.prototype.slice.call(arguments, 1);
      return String(template).replace(/%(\d+)\$[sd]/g, function(match, index) {
        return String(values[Number(index) - 1]);
      });
    };
  }
  if (context._isSmartHubSupported === undefined) context._isSmartHubSupported = false;
  if (!context._previewApps) context._previewApps = {};
  if (!context.activePolls) context.activePolls = {};
  if (!context.window) context.window = { previewPromises: [] };
  if (!context.savePreviewApps) context.savePreviewApps = function() {};
  if (!context.updatePreviewData) context.updatePreviewData = function() {};
  if (!context.beginBackgroundPollingOfHost) context.beginBackgroundPollingOfHost = function() {};
  const source = names.map((name) => extractFunction(indexSource, name)).join('\n');
  const exports = names.map((name) => name + ': ' + name).join(', ');
  vm.runInNewContext(source + '\nthis.testExports = {' + exports + '};', context);
  return context.testExports;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function quietConsole(errors) {
  return {
    log: function() {},
    info: function() {},
    warn: function() {},
    error: function() {
      errors.push(Array.prototype.slice.call(arguments));
    }
  };
}

function createJQueryHarness() {
  const entries = {};
  const handlers = {};

  function entry(selector) {
    if (!entries[selector]) {
      entries[selector] = {
        value: selector === '#ipAddressTextInput' ? 'test-host' : '',
        props: { checked: false, disabled: false },
        classes: {}
      };
    }
    return entries[selector];
  }

  function jquery(selector) {
    const state = entry(selector);
    const api = {
      off: function(event) {
        if (handlers[selector]) delete handlers[selector][event];
        return api;
      },
      on: function(event, handler) {
        if (!handlers[selector]) handlers[selector] = {};
        handlers[selector][event] = handler;
        return api;
      },
      prop: function(name, value) {
        if (arguments.length === 1) return state.props[name];
        state.props[name] = value;
        return api;
      },
      val: function(value) {
        if (arguments.length === 0) return state.value;
        state.value = value;
        return api;
      },
      addClass: function(name) {
        state.classes[name] = true;
        return api;
      },
      removeClass: function(name) {
        delete state.classes[name];
        return api;
      },
      text: function() { return api; },
      html: function() { return api; },
      hide: function() { return api; },
      show: function() { return api; },
      css: function() { return api; },
      children: function() { return api; },
      empty: function() { return api; },
      remove: function() { return api; },
      append: function() { return api; }
    };
    return api;
  }

  jquery.entries = entries;
  jquery.handlers = handlers;
  return jquery;
}

function createPairingContext() {
  const errors = [];
  const jquery = createJQueryHarness();
  const overlay = { style: { display: 'none' } };
  const dialog = {
    opens: 0,
    closes: 0,
    showModal: function() { this.opens += 1; },
    close: function() { this.closes += 1; }
  };
  const context = {
    OperationGuard,
    pairingGenerationGate: OperationGuard.createGenerationGate(),
    pairingCert: {},
    isPairingInProgress: false,
    wasPairingCanceled: false,
    isDialogOpen: false,
    console: quietConsole(errors),
    Math,
    $: jquery,
    document: {
      querySelector: function(selector) {
        return selector === '#pairingDialogOverlay' ? overlay : dialog;
      }
    },
    Navigation: {
      pushes: 0,
      pops: 0,
      push: function() { this.pushes += 1; },
      pop: function() { this.pops += 1; }
    },
    Views: { PairingDialog: {} },
    snackbarLog: function() {},
    snackbarLogLong: function() {}
  };
  return { context, jquery, overlay, dialog };
}

function createPairingHost(result) {
  const pairDeferred = deferred();
  return {
    hostname: 'host',
    paired: result.paired,
    currentGame: result.currentGame,
    online: result.online,
    pollCallbacks: [],
    pairCalls: 0,
    cancelCalls: 0,
    pollServer: function(callback) { this.pollCallbacks.push(callback); },
    pair: function() {
      this.pairCalls += 1;
      return pairDeferred.promise;
    },
    cancelPairingRequest: function() { this.cancelCalls += 1; },
    toString: function() { return 'host'; },
    pairDeferred
  };
}

async function testPairingPreflightOwnership() {
  const staleResults = [
    { online: false, paired: false, currentGame: 0 },
    { online: true, paired: true, currentGame: 0 },
    { online: true, paired: false, currentGame: 7 },
    { online: true, paired: false, currentGame: 0 }
  ];

  for (const staleResult of staleResults) {
    const harness = createPairingContext();
    const pairingDialog = loadFunctions(['pairingDialog'], harness.context).pairingDialog;
    const oldHost = createPairingHost(staleResult);
    const newHost = createPairingHost({ online: true, paired: false, currentGame: 0 });
    let oldSuccess = 0;
    let oldFailure = 0;
    pairingDialog(oldHost, function() { oldSuccess += 1; }, function() { oldFailure += 1; });
    pairingDialog(newHost, function() {}, function() {});

    oldHost.pollCallbacks[0](oldHost);
    assert.strictEqual(oldSuccess, 0);
    assert.strictEqual(oldFailure, 0);
    assert.strictEqual(oldHost.pairCalls, 0);
    assert.strictEqual(harness.dialog.opens, 0);
  }

  const harness = createPairingContext();
  const pairingDialog = loadFunctions(['pairingDialog'], harness.context).pairingDialog;
  const host = createPairingHost({ online: true, paired: false, currentGame: 0 });
  let successCalls = 0;
  pairingDialog(host, function() { successCalls += 1; }, function() {});
  host.pollCallbacks[0](host);
  harness.jquery.handlers['#cancelPairing'].click();
  host.pairDeferred.resolve(true);
  await flush();
  assert.strictEqual(host.cancelCalls, 1);
  assert.strictEqual(successCalls, 0);
  assert.strictEqual(harness.dialog.closes, 1);
}

function createAppsContext() {
  const errors = [];
  const jquery = createJQueryHarness();
  const state = { resets: 0, modes: 0, navigationStops: 0 };
  const context = {
    OperationGuard,
    appsGenerationGate: OperationGuard.createGenerationGate(),
    Promise,
    console: quietConsole(errors),
    $: jquery,
    Image: function() { this.classList = { add: function() {} }; },
    document: {
      getElementById: function() { return { checked: false }; }
    },
    Navigation: {
      stop: function() { state.navigationStops += 1; },
      start: function() {}
    },
    Views: {
      Apps: {
        view: {
          reset: function() { state.resets += 1; }
        }
      }
    },
    stopPollingHosts: function() {},
    endBackgroundPollingOfHost: function() {},
    showAppsMode: function() { state.modes += 1; },
    snackbarLogLong: function() {},
    sortTitles: function(apps) { return apps.slice(); },
    stylizeBoxArt: function() {},
    startGame: function() {},
    isClickPrevented: false,
    setTimeout,
    clearTimeout
  };
  return { context, state };
}

function appHost(appListPromise) {
  return {
    paired: true,
    hostname: 'host',
    getAppList: function() { return appListPromise; },
    toString: function() { return 'host'; }
  };
}

async function outcomeWithin(promise, milliseconds) {
  return Promise.race([
    promise.then(
      (value) => ({ status: 'resolved', value }),
      (error) => ({ status: 'rejected', error })
    ),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout' }), milliseconds))
  ]);
}

async function testStaleAppsAreNotSuccessful() {
  const harness = createAppsContext();
  const showApps = loadFunctions(['showApps'], harness.context).showApps;
  const firstList = deferred();
  const first = showApps(appHost(firstList.promise));
  const invalid = showApps(null);
  const invalidResult = await outcomeWithin(invalid, 100);
  assert.strictEqual(invalidResult.status, 'rejected');
  firstList.resolve([]);
  const firstResult = await outcomeWithin(first, 100);
  assert.strictEqual(firstResult.status, 'rejected');
  assert.strictEqual(firstResult.error && firstResult.error.code, 'STALE_OPERATION');
  assert.strictEqual(harness.state.modes, 0);
  assert.strictEqual(harness.state.resets, 0);
}

async function testMalformedAppsRejectAndRecover() {
  const harness = createAppsContext();
  const showApps = loadFunctions(['showApps'], harness.context).showApps;
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  let result;
  try {
    result = await outcomeWithin(showApps(appHost(Promise.resolve(null))), 100);
    await flush();
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }

  assert.strictEqual(result.status, 'rejected');
  assert.strictEqual(harness.state.resets, 1);
  assert.strictEqual(harness.state.modes, 1);
  assert.deepStrictEqual(unhandled, []);
}

async function testRenderHelperExceptionRejectsAndRecovers() {
  const harness = createAppsContext();
  harness.context.sortTitles = function() {
    throw new Error('render helper failed');
  };
  const showApps = loadFunctions(['showApps'], harness.context).showApps;
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  let result;
  try {
    result = await outcomeWithin(showApps(appHost(Promise.resolve([
      { id: 'X', title: 'Example' }
    ]))), 100);
    await flush();
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }

  assert.strictEqual(result.status, 'rejected');
  assert.strictEqual(harness.state.resets, 1);
  assert.strictEqual(harness.state.modes, 1);
  assert.deepStrictEqual(unhandled, []);
}

function createAsyncRenderingContext() {
  const errors = [];
  const state = {
    images: [],
    timers: [],
    currentCard: null,
    resets: 0,
    modes: 0
  };

  function createElement(properties) {
    return {
      properties: properties || {},
      children: [],
      title: properties && properties['aria-label'] ? properties['aria-label'] : '',
      classes: {},
      handlers: {},
      append: function(child) { this.children.push(child); },
      classList: {
        add: function(name) { this.owner.classes[name] = true; },
        remove: function(name) { delete this.owner.classes[name]; },
        owner: null
      }
    };
  }

  function wrap(element, length) {
    const api = {
      __jqueryWrapper: true,
      element,
      length: length === undefined ? 1 : length,
      off: function(event) {
        if (element && element.handlers) delete element.handlers[event];
        return api;
      },
      on: function(event, handler) {
        if (element && element.handlers) element.handlers[event] = handler;
        return api;
      },
      append: function(child) {
        if (element && element.append) element.append(child);
        return api;
      },
      addClass: function(name) {
        if (element) element.classes[name] = true;
        return api;
      },
      removeClass: function(name) {
        if (element) delete element.classes[name];
        return api;
      },
      children: function() { return api; },
      hide: function() { return api; },
      show: function() { return api; },
      css: function() { return api; },
      empty: function() { return api; },
      remove: function() { return api; },
      html: function() { return api; },
      text: function() { return api; }
    };
    return api;
  }

  const controls = {};
  function jquery(selector, properties) {
    if (selector && selector.__jqueryWrapper) return selector;
    if (typeof selector === 'string' && selector.charAt(0) === '<') {
      return wrap(createElement(properties));
    }
    if (typeof selector === 'string' && selector.indexOf('#game-container-') === 0) {
      return wrap(null, 0);
    }
    if (!controls[selector]) controls[selector] = createElement();
    return wrap(controls[selector]);
  }

  function FakeImage() {
    this.classes = {};
    this.classList = {
      add: (name) => { this.classes[name] = true; }
    };
    state.images.push(this);
  }

  const context = {
    OperationGuard,
    appsGenerationGate: OperationGuard.createGenerationGate(),
    Promise,
    console: quietConsole(errors),
    $: jquery,
    Image: FakeImage,
    document: {
      getElementById: function() { return { checked: false }; },
      querySelector: function() { return state.currentCard; }
    },
    Navigation: {
      stop: function() {},
      start: function() {}
    },
    Views: {
      Apps: {
        view: {
          reset: function() { state.resets += 1; }
        }
      }
    },
    stopPollingHosts: function() {},
    endBackgroundPollingOfHost: function() {},
    showAppsMode: function() { state.modes += 1; },
    snackbarLogLong: function() {},
    sortTitles: function(apps) { return apps.slice(); },
    startGame: function() {},
    isClickPrevented: false,
    setTimeout: function(callback, delay) {
      state.timers.push({ callback, delay });
      return state.timers.length;
    },
    clearTimeout: function() {}
  };
  return { context, state };
}

function asyncRenderingHost(name, apps, boxArtById, refresh) {
  return {
    paired: true,
    hostname: name,
    currentGame: 'X',
    refreshCalls: 0,
    getAppList: function() {
      return Promise.resolve(apps);
    },
    getBoxArt: function(appId) { return boxArtById[appId].promise; },
    refreshServerInfo: function() {
      this.refreshCalls += 1;
      return refresh.promise;
    },
    toString: function() { return name; }
  };
}

async function testAsyncAppRenderingHonorsGeneration() {
  const harness = createAsyncRenderingContext();
  const functions = loadFunctions(['stylizeBoxArt', 'showApps'], harness.context);
  const firstBoxArtSuccess = deferred();
  const firstBoxArtFailure = deferred();
  const firstRefresh = deferred();
  const secondBoxArt = deferred();
  const secondRefresh = deferred();
  const firstHost = asyncRenderingHost('first', [
    { id: 'X', title: 'first app' },
    { id: 'Y', title: 'first extra app' }
  ], {
    X: firstBoxArtSuccess,
    Y: firstBoxArtFailure
  }, firstRefresh);
  const secondHost = asyncRenderingHost('second', [
    { id: 'X', title: 'second app' }
  ], {
    X: secondBoxArt
  }, secondRefresh);
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);

  try {
    const firstLoad = await outcomeWithin(functions.showApps(firstHost), 100);
    assert.strictEqual(firstLoad.status, 'resolved', firstLoad.error && firstLoad.error.stack);
    harness.state.timers[0].callback();
    await flush();
    assert.strictEqual(firstHost.refreshCalls, 1);

    const secondLoad = await outcomeWithin(functions.showApps(secondHost), 100);
    assert.strictEqual(secondLoad.status, 'resolved', secondLoad.error && secondLoad.error.stack);
    const newCard = createTrackedCard('second app');
    harness.state.currentCard = newCard;

    firstRefresh.resolve(true);
    firstBoxArtSuccess.resolve('first-box-art');
    firstBoxArtFailure.reject(new Error('old box art failed'));
    await flush();
    if (harness.state.images[0].onload) harness.state.images[0].onload();
    if (harness.state.images[1].onload) harness.state.images[1].onload();

    assert.strictEqual(newCard.classAdds, 0);
    assert.strictEqual(newCard.title, 'second app');
    assert.strictEqual(harness.state.images[0].src, undefined);
    assert.strictEqual(harness.state.images[0].classes['fade-in'], undefined);
    assert.strictEqual(harness.state.images[1].src, undefined);
    assert.strictEqual(harness.state.images[1].classes['fade-in'], undefined);

    functions.stylizeBoxArt(firstHost, 'X', 1);
    await flush();
    assert.strictEqual(firstHost.refreshCalls, 1);

    harness.state.timers[2].callback();
    await flush();
    assert.strictEqual(secondHost.refreshCalls, 1);
    secondRefresh.resolve(true);
    secondBoxArt.resolve('second-box-art');
    await flush();
    if (harness.state.images[2].onload) harness.state.images[2].onload();

    assert.strictEqual(newCard.classAdds, 1);
    assert.strictEqual(newCard.title, 'second app (Running)');
    assert.strictEqual(harness.state.images[2].src, 'second-box-art');
    assert.strictEqual(harness.state.images[2].classes['fade-in'], true);
    await flush();
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
  assert.deepStrictEqual(unhandled, []);
}

function createTrackedCard(title) {
  const card = {
    title,
    classAdds: 0,
    classRemoves: 0,
    classList: {
      add: function() { card.classAdds += 1; },
      remove: function() { card.classRemoves += 1; }
    }
  };
  return card;
}

function createStorageContext() {
  const errors = [];
  return {
    db: null,
    storeName: 'store',
    console: quietConsole(errors),
    JSON,
    OperationGuard,
    openIndexDB: function(callback) { callback(false); }
  };
}

function testIndexedDbTotality() {
  const context = createStorageContext();
  const readRequest = {};
  const transaction = {
    objectStore: function() {
      return { get: function() { return readRequest; } };
    }
  };
  context.db = {
    transaction: function() { return transaction; }
  };
  const functions = loadFunctions(['callCb', 'getData', 'storeData'], context);
  const readResults = [];
  functions.getData('hosts', function(value) { readResults.push(value); });
  readRequest.onerror('read failed');
  transaction.onerror('transaction failed');
  transaction.onabort('transaction aborted');
  assert.strictEqual(readResults.length, 1);
  assert.strictEqual(readResults[0].hosts, null);

  context.db = null;
  const storeResults = [];
  functions.storeData('hosts', {}, function(success) { storeResults.push(success); });
  assert.deepStrictEqual(storeResults, [false]);
}

async function testSavedCertificateAndHostStateSurviveReload() {
  const savedCertificate = { cert: 'saved-cert', privateKey: 'saved-key' };
  const storedHost = {
    address: '192.168.1.20',
    userEnteredAddress: 'gaming-pc.local',
    localAddress: '192.168.1.20',
    macAddress: '00:11:22:33:44:55',
    httpPort: 47989,
    httpsPort: 47984,
    externalPort: 48010,
    externalIP: '203.0.113.10',
    serverUid: 'server-uid',
    hostname: 'Gaming PC',
    ppkstr: 'saved-pinned-key',
    retainedFutureField: 'keep-me'
  };
  const stored = {
    cert: savedCertificate,
    uniqueid: 'saved-client-id',
    hosts: { 'server-uid': storedHost },
    previewApps: {}
  };
  const initialized = [];
  const context = {
    console: quietConsole([]),
    Promise,
    Object,
    pairingCert: null,
    myUniqueid: null,
    hosts: {},
    getData: function(key, callback) { callback({ [key]: stored[key] }); },
    storeData: function() { throw new Error('existing identity must not be rewritten'); },
    sendMessage: function(method, args) {
      initialized.push({ method, args });
      return Promise.resolve(true);
    },
    NvHTTP: function(address, clientUid, userEnteredAddress, macAddress) {
      this.address = address;
      this.clientUid = clientUid;
      this.userEnteredAddress = userEnteredAddress;
      this.macAddress = macAddress;
    },
    addHostToGrid: function() {},
    startPollingHosts: function() { return Promise.resolve(); },
    stopPollingHosts: function() {},
    restoreUiAfterWasmLoad: function() {},
    updatePreviewData: function() {},
    startSubnetScanner: function() { return Promise.resolve(); },
    snackbarLog: function() {},
    logDiagnostic: function() {},
    setTimeout: function() {},
    window: { i18n: null, previewPromises: [] }
  };
  const loadHTTPCertsCb = loadFunctions(['loadHTTPCertsCb', 'shouldRunStartupSubnetScan'], context).loadHTTPCertsCb;
  loadHTTPCertsCb();
  await flush();

  assert.strictEqual(context.pairingCert, savedCertificate);
  assert.strictEqual(context.myUniqueid, 'saved-client-id');
  assert.strictEqual(context.hosts['server-uid'].ppkstr, 'saved-pinned-key');
  assert.strictEqual(context.hosts['server-uid'].retainedFutureField, 'keep-me');
  assert.strictEqual(context.hosts['server-uid'].userEnteredAddress, 'gaming-pc.local');
  assert.strictEqual(initialized[0].method, 'httpInit');
  assert.strictEqual(initialized[0].args[0], 'saved-cert');
  assert.strictEqual(initialized[0].args[1], 'saved-key');
  assert.strictEqual(initialized[0].args[2], 'saved-client-id');
}

function createAddHostContext(hostPromises, throwDuringSuccess) {
  const errors = [];
  const jquery = createJQueryHarness();
  const overlay = { style: { display: 'none' } };
  const dialog = {
    showModal: function() {},
    close: function() {}
  };
  let hostIndex = 0;
  let validationUpdates = 0;
  let fieldResets = 0;

  function NvHTTP(address) {
    const promise = hostPromises[hostIndex];
    hostIndex += 1;
    this.address = address;
    this.userEnteredAddress = address;
    this.hostname = address;
    this.serverUid = 'host-' + hostIndex;
    this.refreshServerInfoAtAddress = function() { return promise; };
    this.toString = function() { return address; };
  }

  const context = {
    OperationGuard,
    addHostGenerationGate: OperationGuard.createGenerationGate(),
    isDialogOpen: false,
    console: quietConsole(errors),
    $: jquery,
    document: {
      activeElement: { blur: function() {} },
      querySelector: function(selector) {
        return selector === '#addHostDialogOverlay' ? overlay : dialog;
      }
    },
    Navigation: {
      push: function() {},
      pop: function() {},
      switch: function() {}
    },
    Views: { AddHostDialog: {} },
    updateIpAddressInputValidationState: function() { validationUpdates += 1; },
    initIpAddressFields: function() { fieldResets += 1; },
    parseHostAndPortInput: function(value) { return { valid: true, addr: value, port: 47989 }; },
    snackbarLog: function() {},
    snackbarLogLong: function() {},
    NvHTTP,
    myUniqueid: 'uid',
    hosts: {},
    pairingDialog: function() {
      if (throwDuringSuccess) throw new Error('pairing setup failed');
    },
    saveHosts: function() {},
    addHostToGrid: function() {},
    beginBackgroundPollingOfHost: function() {}
  };
  return {
    context,
    jquery,
    get validationUpdates() { return validationUpdates; },
    get fieldResets() { return fieldResets; }
  };
}

async function testAddHostTerminalCleanup() {
  const hostResult = deferred();
  const harness = createAddHostContext([hostResult.promise], true);
  const addHostDialog = loadFunctions(['addHostDialog'], harness.context).addHostDialog;
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    addHostDialog();
    harness.jquery.handlers['#continueAddHost'].click();
    assert.strictEqual(harness.jquery.entries['#continueAddHost'].props.disabled, true);
    hostResult.resolve(true);
    await flush();
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }

  assert.strictEqual(harness.jquery.entries['#continueAddHost'].props.disabled, false);
  assert.strictEqual(harness.jquery.entries['#ipAddressTextInput'].value, '');
  assert.deepStrictEqual(unhandled, []);
}

async function testStaleAddHostDoesNotReleaseCurrentControl() {
  const first = deferred();
  const second = deferred();
  const harness = createAddHostContext([first.promise, second.promise], false);
  const addHostDialog = loadFunctions(['addHostDialog'], harness.context).addHostDialog;
  addHostDialog();
  harness.jquery.handlers['#continueAddHost'].click();
  harness.jquery.handlers['#continueAddHost'].click();

  first.reject(new Error('old request failed'));
  await flush();
  assert.strictEqual(harness.jquery.entries['#continueAddHost'].props.disabled, true);

  second.reject(new Error('current request failed'));
  await flush();
  assert.strictEqual(harness.jquery.entries['#continueAddHost'].props.disabled, false);
}

const cases = {
  pairing: testPairingPreflightOwnership,
  'apps-stale': testStaleAppsAreNotSuccessful,
  'apps-malformed': testMalformedAppsRejectAndRecover,
  'apps-render-throw': testRenderHelperExceptionRejectsAndRecovers,
  'apps-async-generation': testAsyncAppRenderingHonorsGeneration,
  indexeddb: testIndexedDbTotality,
  'saved-identity-reload': testSavedCertificateAndHostStateSurviveReload,
  'add-host-cleanup': testAddHostTerminalCleanup,
  'add-host-stale': testStaleAddHostDoesNotReleaseCurrentControl
};

async function main() {
  const selected = process.argv[2];
  if (selected) {
    assert(cases[selected], 'Unknown test case ' + selected);
    await cases[selected]();
  } else {
    for (const name of Object.keys(cases)) await cases[name]();
  }
  console.log('ui_reliability_behavior_tests: PASS' + (selected ? ' (' + selected + ')' : ''));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
