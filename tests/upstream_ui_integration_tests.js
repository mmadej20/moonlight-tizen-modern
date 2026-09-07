const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

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
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = null;
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

function createDocumentHarness() {
  const elements = {};
  const localized = [];
  const documentElement = {
    language: '',
    setAttribute(name, value) {
      if (name === 'lang') this.language = value;
    },
  };

  function element(id) {
    if (!elements[id]) {
      elements[id] = {
        id,
        attributes: {},
        dataset: {},
        textContent: '',
        value: '',
        switchState: null,
        disabled: false,
        MaterialSwitch: {
          off() { elements[id].switchState = false; },
          on() { elements[id].switchState = true; },
          disable() { elements[id].disabled = true; },
        },
        MaterialSlider: {
          change(value) {
            elements[id].value = String(value);
          },
        },
        setAttribute(name, value) {
          this.attributes[name] = String(value);
          if (name === 'data-value') this.dataset.value = String(value);
        },
        getAttribute(name) {
          return this.attributes[name] || null;
        },
        addEventListener() {},
        appendChild(child) { localized.push(child); },
      };
    }
    return elements[id];
  }

  return {
    elements,
    localized,
    document: {
      documentElement,
      getElementById: element,
      querySelector(selector) {
        if (selector === 'ul.languageMenu') return element('languageMenu');
        if (selector && selector.charAt(0) === '#') return element(selector.slice(1));
        return null;
      },
      querySelectorAll() { return []; },
      createElement() { return element('created-' + localized.length); },
    },
  };
}

async function testStoredLanguageLoadsAndTranslates() {
  const harness = createDocumentHarness();
  const dictionaries = {
    'en-US': { Settings: 'Settings' },
    'pt-BR': { Settings: 'Configurações' },
  };
  const stored = { languagePreference: 'pt-BR' };
  const context = {
    console: { warn() {} },
    navigator: { languages: ['en-US'], language: 'en-US' },
    document: harness.document,
    fetch(url) {
      const locale = /([^/]+)\.json$/.exec(url)[1];
      return Promise.resolve({ ok: true, json: () => Promise.resolve(dictionaries[locale]) });
    },
    getData(key, callback) { callback({ [key]: stored[key] }); },
    storeData() {},
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('wasm/platform/i18n.js', 'utf8'), context);

  const locale = await context.i18n.init();
  assert.strictEqual(locale, 'pt-BR');
  assert.strictEqual(context.t('Settings'), 'Configurações');
  assert.strictEqual(harness.document.documentElement.language, 'pt-BR');
}

function testPreviewServiceExitsWhenApiIsMissing() {
  let exits = 0;
  let serverCreations = 0;
  const currentApplication = {
    appInfo: { packageId: 'Moonlight' },
    getRequestedAppControl() {
      return {
        appControl: {
          data: [{ key: 'Preview', value: ['{"sections":[]}'] }],
        },
      };
    },
    exit() { exits += 1; },
  };
  const moduleObject = { exports: {} };
  const context = {
    module: moduleObject,
    exports: moduleObject.exports,
    console: { log() {}, error() {} },
    webapis: {},
    tizen: {
      application: { getCurrentApplication: () => currentApplication },
      messageport: {
        requestRemoteMessagePort() {
          return { sendMessage() {} };
        },
      },
    },
    require(name) {
      if (name === 'http') {
        return { createServer() { serverCreations += 1; return {}; } };
      }
      if (name === 'url') return { parse() { return {}; } };
      if (name === 'fs') return {};
      throw new Error('Unexpected module ' + name);
    },
  };
  vm.runInNewContext(fs.readFileSync('res/service/service.js', 'utf8'), context);
  moduleObject.exports.onRequest();

  assert.strictEqual(exits, 1, 'the unsupported Preview service request terminates');
  assert.strictEqual(serverCreations, 0, 'the unsupported service does not start an HTTP server');
}

function createSettingsHarness(storedValues, platformVersion) {
  const harness = createDocumentHarness();
  const stores = [];
  const menuItems = {
    '.audioBackendMenu li': [
      { value: 'EMSS', text: 'EMSS' },
      { value: 'WebAudio', text: 'Web Audio' },
    ],
  };

  function jquery(target) {
    if (target && typeof target === 'object' && target.value !== undefined) {
      return {
        data(name) { return name === 'value' ? target.value : undefined; },
        text() { return target.text; },
      };
    }
    const selector = target;
    const id = typeof selector === 'string' && selector.charAt(0) === '#'
      ? selector.slice(1)
      : selector;
    const current = harness.document.getElementById(id);
    const api = {
      0: current,
      each(callback) {
        (menuItems[selector] || []).forEach((item) => callback.call(item));
        return api;
      },
      data(name, value) {
        if (arguments.length === 1) return current.dataset[name];
        current.dataset[name] = value;
        return api;
      },
      attr(name, value) { current.setAttribute(name, value); return api; },
      text(value) {
        if (arguments.length === 0) return current.textContent;
        current.textContent = String(value);
        return api;
      },
      html(value) {
        if (arguments.length === 0) return current.textContent;
        current.textContent = String(value);
        return api;
      },
      val(value) {
        if (arguments.length === 0) return current.value;
        current.value = String(value);
        return api;
      },
    };
    return api;
  }

  const context = {
    console: { log() {}, error() {} },
    document: harness.document,
    window: { i18n: { applyLanguagePreference: () => Promise.resolve() } },
    $: jquery,
    platformVer: platformVersion,
    maxSupportedWidth: 3840,
    getData(key, callback) { callback({ [key]: storedValues[key] }); },
    storeData(key, value) { stores.push({ key, value }); },
    handleUnlockAllFps() {},
    handleIpAddressFieldMode() {},
    updateAudioBackendSettings() {},
  };
  return { context, harness, stores };
}

function runLoadUserData(context) {
  const source = fs.readFileSync('wasm/platform/index.js', 'utf8');
  const fn = extractFunction(source, 'loadUserDataCb');
  vm.runInNewContext(fn + '\nthis.loadUserDataCb = loadUserDataCb;', context);
  context.loadUserDataCb();
}

function testNewSettingsRestoreWithoutOverwritingStoredValues() {
  const storedHarness = createSettingsHarness({
    languagePreference: 'pt-BR',
    audioBackend: 'WebAudio',
    audioJitter: 0,
    gameMode: false,
    speculativeRfi: true,
  }, '7.0');
  runLoadUserData(storedHarness.context);

  assert.strictEqual(storedHarness.harness.elements.selectAudioBackend.dataset.value, 'WebAudio');
  assert.strictEqual(storedHarness.harness.elements.jitterSlider.value, '0');
  assert.strictEqual(storedHarness.harness.elements.gameModeBtn.switchState, false);
  assert.strictEqual(storedHarness.harness.elements.speculativeRfiBtn.switchState, true);
  assert.deepStrictEqual(storedHarness.stores, [], 'loading settings does not rewrite stored false, zero, or list choices');

  const freshHarness = createSettingsHarness({}, '7.0');
  freshHarness.harness.document.getElementById('selectAudioBackend').dataset.value = 'EMSS';
  freshHarness.harness.document.getElementById('jitterSlider').value = '100';
  runLoadUserData(freshHarness.context);

  assert.strictEqual(freshHarness.harness.elements.selectAudioBackend.dataset.value, 'EMSS');
  assert.strictEqual(freshHarness.harness.elements.jitterSlider.value, '100');
  assert.strictEqual(freshHarness.harness.elements.gameModeBtn.switchState, false,
    'Game Mode remains disabled unless the user previously enabled it');
  assert.strictEqual(freshHarness.harness.elements.speculativeRfiBtn.switchState, false);
  assert.deepStrictEqual(freshHarness.stores, [], 'fresh defaults are applied in the UI without overwriting storage');
}

async function main() {
  await testStoredLanguageLoadsAndTranslates();
  testPreviewServiceExitsWhenApiIsMissing();
  testNewSettingsRestoreWithoutOverwritingStoredValues();
  console.log('upstream_ui_integration_tests: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
