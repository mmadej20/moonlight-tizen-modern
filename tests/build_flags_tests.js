'use strict';

// The module was built for size (-Os). Decoding 5 ms of Opus audio takes 1.4 ms on the TV (more than a quarter of the
// time of the audio thread), so the whole module is built with -O2 by default. The level is one setting that the
// compile flags, the link flags, the Docker build and the stream log all share, so a build can be switched back to -Os
// (docker build --build-arg OPT_LEVEL=-Os .) and an exported log says which one it came from.

const assert = require('assert');
const fs = require('fs');

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

const cmake = read('CMakeLists.txt');
const docker = read('Dockerfile');
const main = read('wasm/main.cpp');

// One setting with -O2 as the default, checked before it reaches the compiler.
assert(/set\(MOONLIGHT_OPT_LEVEL "-O2" CACHE STRING/.test(cmake), 'the default level is -O2');
assert(/MOONLIGHT_OPT_LEVEL MATCHES "\^-O\[0-3sz\]\$"/.test(cmake), 'only a real optimization level is accepted');

// Both the compile and the link step use it, and no fixed -Os is left in either.
assert(/add_compile_options\([^)]*\$\{MOONLIGHT_OPT_LEVEL\}[^)]*\)/.test(cmake), 'the compile flags use the setting');
const linkFlags = cmake.slice(cmake.indexOf('LINK_FLAGS'));
assert(/\$\{MOONLIGHT_OPT_LEVEL\}/.test(linkFlags.slice(0, 400)), 'the link flags use the setting');
assert(!/(^|[\s"])-Os(\s|\\|")/m.test(cmake.replace(/#.*$/gm, '')), 'no fixed -Os remains in the build description');

// The stream log carries the level.
assert(/target_compile_definitions\(moonlight-wasm PRIVATE MOONLIGHT_OPT_LEVEL_TEXT="\$\{MOONLIGHT_OPT_LEVEL\}"\)/.test(cmake),
  'the level is compiled into the module');
assert(/#ifndef MOONLIGHT_OPT_LEVEL_TEXT/.test(main), 'a build without the definition says so instead of failing');
assert(/ClLogMessage\("Build optimization: %s\\n", MOONLIGHT_OPT_LEVEL_TEXT\);/.test(main), 'every stream log names the level');

// The Docker build passes the level through and defaults to the same one.
assert(/ARG OPT_LEVEL=-O2/.test(docker));
const configure = docker.slice(docker.indexOf('RUN cmake'), docker.indexOf('cmake --build build'));
assert(/-DMOONLIGHT_OPT_LEVEL=\$\{OPT_LEVEL\}/.test(configure), 'the configure step receives the level');
assert(docker.indexOf('ARG OPT_LEVEL=-O2') < docker.indexOf('RUN cmake'), 'the argument is declared before it is used');

console.log('build flags tests passed');
