const assert = require('assert');
const fs = require('fs');

const pairing = fs.readFileSync('libgamestream/pairing.c', 'utf8');
const httpCpp = fs.readFileSync('wasm/http.cpp', 'utf8');
const mainCpp = fs.readFileSync('wasm/main.cpp', 'utf8');

assert.match(pairing, /gs_decode_hex_exact\(result,[\s\S]*challenge_response_data_enc/);
assert.match(pairing, /gs_decode_hex_exact\(result,[\s\S]*pairing_secret/);
assert.match(pairing, /OPENSSL_free\(signature\)/);
assert.match(pairing, /ASN1_STRING_length\(asnSignature\)\s*!=\s*256/);
assert.match(httpCpp, /mkcert_free\(certKeyPair\)/);
assert.doesNotMatch(httpCpp, /char\* _certStr = strdup/);
assert.match(
  mainCpp,
  /m_HttpRequests\.Create\(callbackId,\s*180000,\s*180000\)/,
  'native pairing requests must allow three minutes for PIN confirmation',
);

console.log('pairing_ownership_wiring_tests: PASS');
