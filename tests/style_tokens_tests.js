'use strict';

const assert = require('assert');
const fs = require('fs');

// The colors that style.css repeats are custom properties. A color that has a token is not written out again in the
// properties that give the token its role, so that changing a token changes the whole interface.
const css = fs.readFileSync('wasm/static/css/style.css', 'utf8').replace(/\r\n/g, '\n');
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

const rootMatch = withoutComments.match(/:root\s*\{([^}]*)\}/);
assert(rootMatch, 'style.css has a :root block');
const tokens = {};
rootMatch[1].split(';').forEach((declaration) => {
  const at = declaration.indexOf(':');
  if (at < 0) return;
  const name = declaration.slice(0, at).trim();
  assert(!(name in tokens), name + ' is defined once');
  tokens[name] = declaration.slice(at + 1).trim();
});

const expected = {
  '--text': '#fff',
  '--text-secondary': '#ececec',
  '--text-disabled': '#cfcfcf',
  '--surface': '#404354',
  '--surface-dark': '#333846',
  '--accent': '#00a3c6',
  '--danger': '#f44336',
  '--success': '#8bc34a',
  '--shadow': 'rgba(0, 0, 0, 0.4)',
  '--shadow-strong': 'rgba(0, 0, 0, 0.6)',
  '--ring-neutral': 'rgba(170, 170, 170, 1)'
};
assert.deepStrictEqual(tokens, expected, 'the tokens keep the colors the interface was built with');

// Every var() names a defined token
const used = withoutComments.match(/var\((--[a-z-]+)\)/g) || [];
assert(used.length >= 40, 'the tokens are used (' + used.length + ' uses)');
used.forEach((use) => {
  const name = use.slice(4, -1);
  assert(name in tokens, name + ' is defined');
});

// Outside of :root a tokenised color is not written out again where the token has its role
const rest = withoutComments.replace(/:root\s*\{[^}]*\}/, '');
const norm = (value) => value.toLowerCase().replace(/\s+/g, '');
const roles = [
  ['--text', ['#fff'], ['color']],
  ['--text-secondary', ['#ececec'], ['color']],
  ['--text-disabled', ['#cfcfcf'], ['color']],
  ['--surface', ['#404354'], ['background-color']],
  ['--surface-dark', ['#333846'], ['background-color']],
  ['--accent', ['#00a3c6', 'rgba(0,163,198,1)'], ['color', 'background-color', 'outline', 'border-color', 'box-shadow']],
  ['--danger', ['#f44336', 'rgba(244,67,54,1)'], ['color', 'background-color', 'outline', 'box-shadow']],
  ['--success', ['#8bc34a'], ['color', 'background-color', 'outline']],
  ['--shadow', ['rgba(0,0,0,0.4)'], ['box-shadow', 'text-shadow', 'filter']],
  ['--shadow-strong', ['rgba(0,0,0,0.6)'], ['box-shadow']],
  ['--ring-neutral', ['rgba(170,170,170,1)'], ['box-shadow']]
];
const declarations = rest.match(/[a-zA-Z-]+\s*:\s*[^;{}]*/g) || [];
declarations.forEach((declaration) => {
  const at = declaration.indexOf(':');
  const property = declaration.slice(0, at).trim().toLowerCase();
  const value = declaration.slice(at + 1);
  (value.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) || []).forEach((color) => {
    roles.forEach(([name, spellings, properties]) => {
      assert(!(properties.includes(property) && spellings.includes(norm(color))),
        'use ' + name + ' instead of ' + color + ' in ' + property + ': ' + declaration.trim());
    });
  });
});

console.log('style_tokens_tests: PASS');
