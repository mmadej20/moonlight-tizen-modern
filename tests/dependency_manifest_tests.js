const assert = require('assert');
const fs = require('fs');

const pkg = require('../package.json');
const lock = require('../package-lock.json');
const html = fs.readFileSync('wasm/index.html', 'utf8');
const config = fs.readFileSync('res/config.xml', 'utf8');
const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
const developmentWorkflow = fs.readFileSync('.github/workflows/release-development.yml', 'utf8');
const stableWorkflow = fs.readFileSync('.github/workflows/release-stable.yml', 'utf8');

const expectedJavaScriptSuites = [
  'tests/audio_backend_behavior_tests.js',
  'tests/auto_wol_behavior_tests.js',
  'tests/box_art_behavior_tests.js',
  'tests/box_art_queue_tests.js',
  'tests/common_log_capture_wiring_tests.js',
  'tests/connection_wiring_tests.js',
  'tests/dependency_manifest_tests.js',
  'tests/diagnostic_log_manager_tests.js',
  'tests/diagnostic_logs_js_tests.js',
  'tests/gamepad_polling_tests.js',
  'tests/http_bridge_tests.js',
  'tests/media_ownership_wiring_tests.js',
  'tests/operation_guard_tests.js',
  'tests/pairing_cancellation_behavior_tests.js',
  'tests/pairing_ownership_wiring_tests.js',
  'tests/pairing_timeout_behavior_tests.js',
  'tests/start_responsiveness_wiring_tests.js',
  'tests/stream_diagnostics_wiring_tests.js',
  'tests/stream_watchdog_tests.js',
  'tests/subnet_scanner_tests.js',
  'tests/ui_reliability_behavior_tests.js',
  'tests/ui_reliability_wiring_tests.js',
  'tests/upstream_ui_integration_tests.js',
  'tests/upstream_v118_integration_tests.js',
  'tests/wasm_atomics_guard_tests.js',
];

const discoveredJavaScriptSuites = fs.readdirSync('tests')
  .filter((name) => name.endsWith('_tests.js'))
  .map((name) => `tests/${name}`)
  .sort();

assert.deepStrictEqual(discoveredJavaScriptSuites, expectedJavaScriptSuites);
const referencedJavaScriptSuites = Array.from(
  pkg.scripts['test:js'].matchAll(/node (tests\/[^&\s]+_tests\.js)/g),
  (match) => match[1]
).sort();
assert.deepStrictEqual(referencedJavaScriptSuites, expectedJavaScriptSuites);

for (const workflow of [developmentWorkflow, stableWorkflow]) {
  assert.match(workflow, /docker create --name temp_container \$IMAGE_TAG artifact-only/);
  assert.doesNotMatch(workflow, /docker run(?:\s|$)/);
  assert.doesNotMatch(workflow, /docker (?:start|stop) temp_container/);
  assert.match(workflow, /docker cp temp_container:\/home\/moonlight\/Moonlight\.wgt \./);
  assert.match(workflow, /docker rm temp_container/);
  assert.match(workflow, /docker create --name temp_container_forcegm \$IMAGE_TAG_FORCEGM artifact-only/);
  assert.match(workflow, /docker cp temp_container_forcegm:\/home\/moonlight\/Moonlight-ForceGM\.wgt \./);
  assert(workflow.includes('steps.build_standard.outputs.digest'));
  assert(workflow.includes('steps.build_forcegm.outputs.digest'));
  assert(workflow.includes('needs.build-and-push-image.outputs.standard_digest'));
  assert(workflow.includes('needs.build-and-push-image.outputs.forcegm_digest'));
}

assert.strictEqual(pkg.engines.node, '24.18.0');
assert.strictEqual(pkg.dependencies.jquery, '2.2.0');
assert.strictEqual(lock.lockfileVersion, 3);
assert.strictEqual(lock.packages[''].dependencies.jquery, '2.2.0');
assert.strictEqual(lock.packages['node_modules/jquery'].version, '2.2.0');
assert.strictEqual(
  lock.packages['node_modules/jquery'].resolved,
  'https://registry.npmjs.org/jquery/-/jquery-2.2.0.tgz'
);
assert.strictEqual(
  lock.packages['node_modules/jquery'].integrity,
  'sha512-bQLMb56JzEBBs2CMzy8llOL0J1xm/JkDma6+UnF2cSPYJmvQHS9yZ+YGny/1YydkdZm8j0Ny8peiaeoWEwy9Zg=='
);
assert(html.includes('static/js/jquery-2.2.0.min.js'));
assert(!html.includes('jquery-4.0.0'));
assert(config.includes('required_version="5.5"'));
assert(dockerfile.includes('FROM node:24.18.0-alpine AS frontend-dependencies'));
assert(dockerfile.includes('npm ci --omit=dev --ignore-scripts'));
assert(dockerfile.includes('/wasm/static/js/jquery-2.2.0.min.js'));
assert(!dockerfile.includes('/wasm/static/js/jquery-4.0.0.min.js'));
assert(dockerfile.includes('AS builder'));
assert(dockerfile.includes('FROM scratch AS artifact'));
assert(dockerfile.includes('COPY --from=builder /home/moonlight/Moonlight*.wgt /home/moonlight/'));
assert(config.includes('version="1.18.0"'));
assert.strictEqual(pkg.version, '1.18.0');
assert.strictEqual(lock.version, pkg.version);
console.log('dependency_manifest_tests: PASS');
