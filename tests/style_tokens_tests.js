'use strict';

const assert = require('assert');
const fs = require('fs');

// The colors of the interface are custom properties of ui.css. Every var() names a token that is defined, the tokens keep the
// colors the design was built with, and the stylesheet that came before (style.css) is gone, so there is one place for them.
assert(!fs.existsSync('wasm/static/css/style.css'), 'the old stylesheet is gone');
const css = fs.readFileSync('wasm/static/css/ui.css', 'utf8').replace(/\r\n/g, '\n');
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

const rootMatch = withoutComments.match(/:root\s*\{([^}]*)\}/);
assert(rootMatch, 'ui.css has a :root block');
const tokens = {};
rootMatch[1].split(';').forEach((declaration) => {
  const at = declaration.indexOf(':');
  if (at < 0) return;
  const name = declaration.slice(0, at).trim();
  assert(!(name in tokens), name + ' is defined once');
  tokens[name] = declaration.slice(at + 1).trim();
});

const colors = {
  '--ui-bg': '#080C15',
  '--ui-surface': '#131823',
  '--ui-surface-raised': '#1F2733',
  '--ui-line': '#3A4353',
  '--ui-text': '#EFF2F7',
  '--ui-mute': '#B4BBC8',
  '--ui-moon': '#F5DE87',
  '--ui-ink': '#1B1505',
  '--ui-ok': '#4AE2AC',
  '--ui-warn': '#F9B64F',
  '--ui-bad': '#FE8B83'
};
Object.keys(colors).forEach((name) => assert.strictEqual(tokens[name], colors[name], name + ' keeps its color'));

const used = withoutComments.match(/var\((--[a-z-]+)\)/g) || [];
assert(used.length >= 200, 'the tokens are used (' + used.length + ' uses)');
used.forEach((use) => {
  const name = use.slice(4, -1);
  assert(name in tokens, name + ' is defined');
});

// A token is not written out again where it has its role: the colors of the page are in :root and nowhere else
const rest = withoutComments.replace(/:root\s*\{[^}]*\}/, '');
const norm = (value) => value.toLowerCase().replace(/\s+/g, '');
const spelled = Object.keys(colors).map((name) => [name, colors[name].toLowerCase()]);
(rest.match(/#[0-9a-fA-F]{3,8}\b/g) || []).forEach((color) => {
  spelled.forEach(([name, value]) => assert(norm(color) !== value, 'use ' + name + ' instead of ' + color));
});

console.log('style_tokens_tests: PASS');
