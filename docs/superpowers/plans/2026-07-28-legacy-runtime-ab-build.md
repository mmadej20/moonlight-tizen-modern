# Legacy Runtime A/B Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a signed WGT from the current reliability fixes with the pre-`7eff49d` Tizen 5.5 and jQuery 2.2.0 runtime profile.

**Architecture:** Keep the native WASM compiler, CMake configuration, signing flow, and current C/C++ sources unchanged. Change only the manifest and frontend dependency packaged into the WGT, with the dependency lock and regression test proving the selected profile.

**Tech Stack:** Tizen Studio CLI 6.1, Samsung Emscripten 1.39.4.7 fastcomp, Docker, Node.js 24.18.0/npm lockfile, jQuery 2.2.0, Node assert tests.

## Global Constraints

- Retain every commit after `7eff49d`, including current audio, HEVC timing, recovery, and diagnostics changes.
- Package `required_version="5.5"`.
- Package and reference jQuery 2.2.0; do not package jQuery 4.0.0.
- Retain the artifact-only Docker final stage and current signing flow.
- Do not claim a different WASM compiler or successful TV validation.

---

### Task 1: Lock the legacy runtime contract with a failing test

**Files:**
- Modify: `tests/dependency_manifest_tests.js`

**Interfaces:**
- Consumes: `package.json`, `package-lock.json`, `res/config.xml`, `wasm/index.html`, `Dockerfile`
- Produces: assertions defining the exact legacy runtime package

- [ ] **Step 1: Change the manifest assertions**

Assert:

```js
assert.strictEqual(pkg.dependencies.jquery, '2.2.0');
assert.strictEqual(lock.packages[''].dependencies.jquery, '2.2.0');
assert.strictEqual(lock.packages['node_modules/jquery'].version, '2.2.0');
assert(html.includes('static/js/jquery-2.2.0.min.js'));
assert(!html.includes('jquery-4.0.0'));
assert(config.includes('required_version="5.5"'));
assert(dockerfile.includes('/wasm/static/js/jquery-2.2.0.min.js'));
assert(!dockerfile.includes('/wasm/static/js/jquery-4.0.0.min.js'));
```

- [ ] **Step 2: Run the targeted test**

Run:

```powershell
rtk node tests/dependency_manifest_tests.js
```

Expected: FAIL because the repository still declares jQuery 4.0.0 and Tizen 9.0.

- [ ] **Step 3: Commit the red test**

```powershell
rtk git add tests/dependency_manifest_tests.js
rtk git commit -m "test: require legacy Tizen runtime profile"
```

### Task 2: Restore the legacy manifest and frontend dependency

**Files:**
- Modify: `res/config.xml`
- Modify: `wasm/index.html`
- Modify: `Dockerfile`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/dependency_manifest_tests.js`

**Interfaces:**
- Consumes: the assertions from Task 1
- Produces: a reproducible jQuery 2.2.0 asset and Tizen 5.5 manifest in the Docker package

- [ ] **Step 1: Select the legacy versions**

Make these exact substitutions:

```text
required_version="9.0" -> required_version="5.5"
jquery-4.0.0.min.js -> jquery-2.2.0.min.js
"jquery": "4.0.0" -> "jquery": "2.2.0"
```

- [ ] **Step 2: Regenerate only the npm lockfile**

Run:

```powershell
rtk npm install --package-lock-only --ignore-scripts
```

Expected: exit 0 and `package-lock.json` locks `jquery@2.2.0`.

- [ ] **Step 3: Run the targeted test**

Run:

```powershell
rtk node tests/dependency_manifest_tests.js
```

Expected: `dependency_manifest_tests: PASS`.

- [ ] **Step 4: Commit the runtime profile**

```powershell
rtk git add Dockerfile package.json package-lock.json res/config.xml wasm/index.html
rtk git commit -m "build: restore legacy Tizen runtime profile"
```

### Task 3: Verify and build the signed WGT

**Files:**
- Replace generated artifact: `Moonlight.wgt`

**Interfaces:**
- Consumes: committed legacy profile and current native sources
- Produces: signed test package plus recorded provenance

- [ ] **Step 1: Run the complete JavaScript suite**

Run:

```powershell
rtk npm run test:js
```

Expected: all listed JavaScript suites print their PASS markers and npm exits 0.

- [ ] **Step 2: Run native regression scripts**

Run the repository's current PowerShell native receiver/test scripts using
Windows PowerShell, because `pwsh` is not installed:

```powershell
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/receiver_integration_test.ps1
```

Expected: exit 0 and the receiver integration PASS marker.

- [ ] **Step 3: Build the Docker artifact**

Run:

```powershell
rtk docker build --progress=plain -t moonlight-tizen-legacy-runtime .
```

Expected: exit 0 and an artifact image containing `/home/moonlight/Moonlight.wgt`.

- [ ] **Step 4: Extract and inspect the WGT**

Create a uniquely named stopped container, copy its WGT to the repository,
remove that exact container, and inspect the ZIP entries and file contents.
Require both signature files, Tizen 5.5, jQuery 2.2.0, and no jQuery 4.0.0.

- [ ] **Step 5: Record provenance**

Record:

```text
source commit
artifact absolute path
byte length
last-write UTC
SHA-256
```

Confirm `git status --short --branch` contains no uncommitted source changes.
