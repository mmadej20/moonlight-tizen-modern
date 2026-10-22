'use strict';

const assert = require('assert');
const fs = require('fs');

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const html = read('wasm/index.html');
const index = read('wasm/platform/index.js');
const uiCss = read('wasm/static/css/ui.css');

// The dialogs are still the elements that the navigation and the application open: only their look is new
assert.strictEqual((html.match(/<dialog id="/g) || []).length, 12, 'the twelve dialogs of the page');
for (const id of ['closeAppSupport', 'closeNavGuide', 'closeUpdateApp']) {
  assert(html.includes('id="' + id + '"'), id + ' is in the page');
}
for (const id of ['closeHostMenu', 'closeHostDetails']) {
  assert(index.includes("id: '" + id + "'"), id + ' is made by the application');
}
assert(/\$\(hostMenuDialogOverlay\)\.css\('display', 'flex'\)/.test(index), 'the application shows an overlay with display flex');
assert(/\.dialog-overlay \{[^}]*display: none;[^}]*align-items: center;[^}]*justify-content: center;/.test(uiCss), 'and the overlay is hidden until then');

// A dialog is a card on a scrim, with the fonts of the interface
assert(/\.mdl-dialog \{[^}]*width: 720px;[^}]*border-radius: 32px;[^}]*background: var\(--ui-surface\);/.test(uiCss));
assert(/\.large-dialog \{\s*width: 1500px;/.test(uiCss));
assert(/\.mdl-dialog__title \{[^}]*font: 700 44px\/1\.1 var\(--ui-font-display\);/.test(uiCss));

// A button of a dialog is written with the specificity of the colored raised button of MDL, whose hover, focus and active
// states set a background and a shadow of their own
assert(/\.mdl-dialog button\.mdl-button\.mdl-button--raised\.mdl-button--colored \{[^}]*background: var\(--ui-surface-raised\);[^}]*box-shadow: none;/.test(uiCss));
assert(/\.mdl-dialog button\.mdl-button\.mdl-button--raised\.mdl-button--colored\[id\^="continue"\][^{]*\{[^}]*background: var\(--ui-moon\);/.test(uiCss),
  'the button that goes on is filled');
assert(/\.mdl-dialog \.mdl-button:hover, \.mdl-dialog \.mdl-button:focus, \.mdl-dialog \.mdl-button\.hovered \{[^}]*outline: 6px solid var\(--ui-ring\);/.test(uiCss));
assert(!/transition:\s*all/.test(uiCss));

// The menu of a host has buttons that the application makes, in a dialog that has an id of its own
assert(/dialog\[id\^="hostMenuDialog-"\] \.mdl-dialog__content \{[^}]*flex-direction: column;/.test(uiCss));
assert(/id: 'hostMenuDialog-' \+ host\.serverUid/.test(index));

// The fields of the dialog that adds a host, and the switch of the one that wakes a PC, have the look of the settings
assert(/\.mdl-textfield__input, #ipAddressTextInput \{[^}]*height: 64px;[^}]*border: 2px solid var\(--ui-line\);/.test(uiCss));
assert(/\.ip-address-select-field[^{]*\{[^}]*width: 132px;/.test(uiCss));
assert(/#autoWolCheckboxContainer \.mdl-switch\.is-checked \.mdl-switch__thumb \{[^}]*transform: translateX\(40px\)/.test(uiCss));

// The loading screen: a moon above the bar, a bar without the pale buffer of MDL
assert(/<svg id="wasmSpinnerLogo"/.test(html) && !/ic_moonlight_logo/.test(html), 'the moon is drawn by the page');
assert(/\.mdl-progress > \.bufferbar \{\s*display: none;/.test(uiCss));
// The captions of the loading screen are inside of the bar, which is 10 px high: a bar that clips its content hides them
assert(!/\.mdl-progress \{[^}]*overflow/.test(uiCss), 'the bar does not clip the captions');
assert(/<h4 id="wasmSpinnerMessage"><\/h4>/.test(html) && /<h4 id="loadingSpinnerMessage"><\/h4>/.test(html));
assert(/\.mdl-progress > \.auxbar \{[^}]*background-image: none !important;[^}]*mask: none !important;/.test(uiCss));
assert(/\.mdl-progress > \.progressbar, \.mdl-progress\.mdl-progress__indeterminate > \.bar1, \.mdl-progress\.mdl-progress__indeterminate > \.bar3 \{\s*background-color: var\(--ui-moon\);/.test(uiCss));

// The button of a new update is one of the pills of the interface, shown by a class and not by styles written on it
const updateButton = index.slice(index.indexOf('function updateAppButton('), index.indexOf('// Show the Update Moonlight dialog'));
assert(/class: 'ui-btn ui-fx'/.test(updateButton));
assert(!/mdl-badge|data-badge|mdl-button/.test(updateButton), 'no badge and no MDL button');
assert(/updateAppBtn\.addClass\('is-shown'\)/.test(updateButton) && !/updateAppBtn\.css\(/.test(updateButton));
assert(/#updateAppBtn\.is-shown \{\s*opacity: 1;/.test(uiCss));

console.log('dialogs_screen_tests: PASS');
