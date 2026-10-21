'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { patchEmbindString, ORIGINAL, PATCHED } = require('../tools/patch-embind-string.js');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');

// fromWireType of std::string in the generated moonlight-wasm.js of the Samsung Emscripten 1.39.4.7, with the functions it
// uses. The patch has to find the reading of the string in exactly this text.
const UTF8_TO_STRING =
  'function UTF8ArrayToString(u8Array,idx,maxBytesToRead){var endIdx=idx+maxBytesToRead;var str="";while(!(idx>=endIdx)){' +
  'var u0=u8Array[idx++];if(!u0)return str;if(!(u0&128)){str+=String.fromCharCode(u0);continue}var u1=u8Array[idx++]&63;' +
  'if((u0&224)==192){str+=String.fromCharCode((u0&31)<<6|u1);continue}var u2=u8Array[idx++]&63;' +
  'if((u0&240)==224){u0=(u0&15)<<12|u1<<6|u2}else{u0=(u0&7)<<18|u1<<12|u2<<6|u8Array[idx++]&63}' +
  'if(u0<65536){str+=String.fromCharCode(u0)}else{var ch=u0-65536;str+=String.fromCharCode(55296|ch>>10,56320|ch&1023)}}return str}' +
  'function UTF8ToString(ptr,maxBytesToRead){return ptr?UTF8ArrayToString(HEAPU8,ptr,maxBytesToRead):""}';
const FROM_WIRE_TYPE =
  'function(value){var length=HEAPU32[value>>2];var str;if(stdStringIsUTF8){' + ORIGINAL +
  'else{var a=new Array(length);for(var i=0;i<length;++i){a[i]=String.fromCharCode(HEAPU8[value+4+i])}str=a.join("")}_free(value);return str}';
const SOURCE = 'var a=1;function __embind_register_std_string(rawType,name){var stdStringIsUTF8=name==="std::string";' +
  'registerType(rawType,{name:name,"fromWireType":' + FROM_WIRE_TYPE + ',"toWireType":function(destructors,value){}})}function after(){}';

// The reading of the string is found once and only once; a changed toolchain must fail the build instead of keeping the write
assert(SOURCE.includes(ORIGINAL), 'the fixture contains the code that the patch looks for');
assert(/HEAPU8\[value\+4\+length\]=0/.test(ORIGINAL), 'the original writes a zero after the string');
assert(!/HEAPU8\[[^\]]*\]=[^=]/.test(PATCHED), 'the patched reading writes nothing');
const patched = patchEmbindString(SOURCE);
assert(patched.includes(PATCHED));
assert(!patched.includes(ORIGINAL));
assert(patched.startsWith('var a=1;') && patched.endsWith('function after(){}'), 'the rest of the file is untouched');
assert.throws(() => patchEmbindString(patched), /already patched/);
assert.throws(() => patchEmbindString('var nothing=1;'), /found 0 times/);
assert.throws(() => patchEmbindString(SOURCE + SOURCE), /found 2 times/);
assert.doesNotThrow(() => new Function(patched + ';'), 'the patched file still parses');

// What the reading does, run against a heap that records every write. The wire buffer is a length of 4 bytes, then the bytes,
// and no terminator: the byte after it belongs to something else (the head of the next chunk of the allocator).
function createReader(source) {
  const writes = [];
  const memory = new Uint8Array(4096);
  const HEAPU8 = new Proxy(memory, {
    set(target, key, value) { writes.push([Number(key), value]); target[key] = value; return true; }
  });
  const registrations = {};
  const body = source.replace('var a=1;', 'var a=1;' + UTF8_TO_STRING);
  const factory = new Function('HEAPU8', 'HEAPU32', '_free', 'registerType', body + ';return __embind_register_std_string;');
  const heap32 = new Uint32Array(memory.buffer);
  const register = factory(HEAPU8, heap32, function() {}, function(raw, type) { registrations.type = type; });
  register(1, 'std::string');
  return {
    writes,
    // puts a string at address 64 the way the C++ side does and reads it back; `after` is the byte after the buffer
    read(bytes, after) {
      const start = 64;
      heap32[start >> 2] = bytes.length;
      for (let i = 0; i < bytes.length; i++) memory[start + 4 + i] = bytes[i];
      memory[start + 4 + bytes.length] = after;
      writes.length = 0;
      return registrations.type.fromWireType(start);
    },
    memory
  };
}

const encode = (text) => Array.from(Buffer.from(text, 'utf8'));

for (const [name, source] of [['original', SOURCE], ['patched', patched]]) {
  const reader = createReader(source);
  assert.strictEqual(reader.read(encode('video=1076/567ms audio=550'), 0x4b), 'video=1076/567ms audio=550', name + ': plain text');
  assert.strictEqual(reader.read(encode('zażółć gęślą jaźń 😀'), 0x21), 'zażółć gęślą jaźń 😀', name + ': multi-byte text');
  assert.strictEqual(reader.read([0x61, 0, 0x62], 0x7f), 'a\u0000b', name + ': a zero inside the string splits it and is kept');
  assert.strictEqual(reader.read([], 0x7f), '', name + ': empty string');
  assert.strictEqual(reader.read(encode('x'.repeat(368)), 0x43), 'x'.repeat(368), name + ': a length that is a multiple of 8');
}

// The difference: the original writes into the byte after the buffer (and puts the old one back), the patched one never does
{
  const reader = createReader(SOURCE);
  reader.read(encode('x'.repeat(368)), 0x43);
  const after = 64 + 4 + 368;
  assert.deepStrictEqual(reader.writes, [[after, 0], [after, 0x43]], 'the original writes a zero past the end and restores it');
}
{
  const reader = createReader(patched);
  for (const length of [0, 1, 7, 8, 9, 368, 372]) {
    reader.read(encode('y'.repeat(length)), 0x43);
    assert.deepStrictEqual(reader.writes, [], 'the patched reading writes nothing for a length of ' + length);
  }
  // another thread changes the byte after the buffer while the string is being read: the change must stay
  reader.memory[64 + 4 + 8] = 0x43;
  const text = reader.read(encode('z'.repeat(8)), 0x43);
  reader.memory[64 + 4 + 8] = 0x4b;
  assert.strictEqual(text, 'z'.repeat(8));
  assert.strictEqual(reader.memory[64 + 4 + 8], 0x4b, 'a byte that another thread wrote after the string is not put back');
}

// The Docker build runs the patch after the module is linked and fails when it does not apply
const docker = read('Dockerfile');
const dockerignore = read('.dockerignore');
assert(/COPY --chown=moonlight tools\/patch-embind-string\.js \.\/moonlight-tizen\/tools\//.test(docker));
assert(/RUN \/home\/moonlight\/emscripten-release-bundle\/emsdk\/node\/12\.9\.1_64bit\/bin\/node moonlight-tizen\/tools\/patch-embind-string\.js build\/widget\/moonlight-wasm\.js\n/.test(docker),
  'it runs on the Node of the SDK, on the linked module');
assert(docker.indexOf('cmake --install build') < docker.indexOf('patch-embind-string.js build/widget/moonlight-wasm.js'),
  'the patch runs after the module is installed into the widget folder');
assert(docker.indexOf('patch-embind-string.js build/widget/moonlight-wasm.js') < docker.indexOf('tizen package'),
  'and before the application is packaged');
assert(/^!tools\/patch-embind-string\.js$/m.test(dockerignore));

console.log('embind_string_patch_tests: PASS');
