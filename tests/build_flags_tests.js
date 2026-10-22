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

// Opus decodes the audio with float arithmetic by default (fixed-point decoded 5 ms of audio in 1.26 ms on the TV). It is one option that
// picks the part of SILK that depends on the arithmetic, the include directory and the FIXED_POINT definition together, so the two can never
// be mixed, and the stream log says which one decoded the audio.
{
  const code = cmake.replace(/#.*$/gm, '');
  assert(/option\(MOONLIGHT_OPUS_FIXED_POINT "[^"]+" OFF\)/.test(code), 'the float build is the default');
  const list = (name) => {
    const match = new RegExp('set\\(' + name + '\\n([^)]*)\\)').exec(code);
    assert(match, 'missing list ' + name);
    return match[1].split('\n').map((line) => line.trim()).filter(Boolean);
  };
  const common = list('MOONLIGHT_OPUS_COMMON_SOURCES');
  const fixed = list('MOONLIGHT_OPUS_FIXED_SOURCES');
  const floating = list('MOONLIGHT_OPUS_FLOAT_SOURCES');
  const all = common.concat(fixed, floating);
  all.forEach((file) => assert(fs.existsSync(file), file + ' exists'));
  assert.strictEqual(new Set(all).size, all.length, 'no file is listed twice');
  assert(common.every((file) => !/^opus\/silk\/(fixed|float)\//.test(file)), 'the common part has nothing that depends on the arithmetic');
  assert(fixed.every((file) => file.startsWith('opus/silk/fixed/')) && floating.every((file) => file.startsWith('opus/silk/float/')));
  // Every file of the directory is in its list: a source that is left out would be a missing symbol that only the link of the WASM shows
  for (const [directory, listed] of [['opus/silk/fixed', fixed], ['opus/silk/float', floating]]) {
    const onDisk = fs.readdirSync(directory).filter((name) => name.endsWith('.c')).map((name) => directory + '/' + name).sort();
    assert.deepStrictEqual(listed.slice().sort(), onDisk, directory + ' is listed whole');
  }
  assert(/if\(MOONLIGHT_OPUS_FIXED_POINT\)\s*set\(MOONLIGHT_OPUS_SOURCES \$\{MOONLIGHT_OPUS_COMMON_SOURCES\} \$\{MOONLIGHT_OPUS_FIXED_SOURCES\}\)\s*set\(MOONLIGHT_OPUS_ARITHMETIC_INCLUDE opus\/silk\/fixed\)\s*set\(MOONLIGHT_OPUS_ARITHMETIC_DEFINITIONS FIXED_POINT\)/.test(code));
  assert(/else\(\)\s*set\(MOONLIGHT_OPUS_SOURCES \$\{MOONLIGHT_OPUS_COMMON_SOURCES\} \$\{MOONLIGHT_OPUS_FLOAT_SOURCES\}\)\s*set\(MOONLIGHT_OPUS_ARITHMETIC_INCLUDE opus\/silk\/float\)\s*set\(MOONLIGHT_OPUS_ARITHMETIC_DEFINITIONS ""\)/.test(code));
  assert(!/^\s*FIXED_POINT\s*$/m.test(code), 'FIXED_POINT is only ever set through the option');
  assert(/add_library\(opus STATIC \$\{MOONLIGHT_OPUS_SOURCES\}\)/.test(code));
  assert(/target_compile_definitions\(moonlight-wasm PRIVATE MOONLIGHT_OPUS_TEXT="\$\{MOONLIGHT_OPUS_TEXT\}"\)/.test(code), 'the log gets the name');
  assert(/#ifndef MOONLIGHT_OPUS_TEXT/.test(main));
  assert(/ClLogMessage\("Opus decoder: %s\\n", MOONLIGHT_OPUS_TEXT\);/.test(main), 'every stream log names the decoder');
  assert(/ARG OPUS_FIXED_POINT=OFF/.test(docker) && /-DMOONLIGHT_OPUS_FIXED_POINT=\$\{OPUS_FIXED_POINT\}/.test(configure), 'the Docker build passes the choice through');
  assert(docker.indexOf('ARG OPUS_FIXED_POINT=OFF') < docker.indexOf('RUN cmake'));
}

console.log('build flags tests passed');
