'use strict';

// What this fork took from upstream v1.20.0, what it changed while taking it, and what it left out on purpose.

const assert = require('assert');
const fs = require('fs');

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const index = read('wasm/platform/index.js');
const messages = read('wasm/platform/messages.js');
const navigation = read('wasm/platform/navigation.js');
const html = read('wasm/index.html');
const i18n = read('wasm/platform/i18n.js');
const mainCpp = read('wasm/main.cpp');

// The colour space follows the HDR switch: Rec. 709 for SDR instead of the Rec. 601 default, Rec. 2020 for HDR
assert(/m_StreamConfig\.colorSpace = 0;[\s\S]{0,400}m_StreamConfig\.colorSpace \|= hdrMode \? COLORSPACE_REC_2020 : COLORSPACE_REC_709;/.test(mainCpp));

// Quit the app on the host after the stream: a switch in the host settings, off by default, stored and restored
assert(/<input type="checkbox" id="quitAppAfterSwitch" class="mdl-switch__input">/.test(html));
assert(/'optimizeGamesBtn',\s*'quitAppAfterBtn',\s*'removeAllHostsBtn'/.test(navigation), 'the switch is reachable in the host settings');
assert(/\$\('#quitAppAfterSwitch'\)\.on\('click', saveQuitAppAfter\);/.test(index));
assert(/storeData\('quitAppAfter', chosenQuitAppAfter, null\);/.test(index));
assert(/previousValue\.quitAppAfter == null\) \{\s*document\.querySelector\('#quitAppAfterBtn'\)\.MaterialSwitch\.off\(\);/.test(index));
assert(/const defaultQuitAppAfter = false;/.test(index));
// It quits only after a normal end, and never when the stream stopped because the application went to the background: that stream
// is meant to be resumed
assert(/var quitAppAfterStream = errorCode === 0 && !wasStreamStoppedInBackground && \$\('#quitAppAfterSwitch'\)\.prop\('checked'\);\s*var appListReady = quitAppAfterStream \? stopGame\(api\) : showApps\(api\);/.test(messages));

// A stream stops when the application goes to the background, and the user is told when it comes back
assert(/document\.addEventListener\('visibilitychange', function\(\) \{[\s\S]*?if \(isHidden && isInGame === true\) \{[\s\S]*?Module\.stopStream\(\);\s*wasStreamStoppedInBackground = true;[\s\S]*?\} else if \(!isHidden && wasStreamStoppedInBackground\) \{\s*(?:\/\/[^\n]*\n\s*)?wasStreamStoppedInBackground = false;/.test(index));
assert(/logDiagnostic\(details\);/.test(index), 'the change of visibility goes to the diagnostic log');

// 144 FPS is gone: the TV cannot start it
assert(!/144/.test(index.replace(/1440/g, '')), 'no 144 FPS in the controller');

// HDR is switched off and locked on a TV that cannot show it. The question to the TV is guarded, because it throws where the
// Samsung API is missing, and a TV that cannot answer keeps the setting
assert(/var isHdrCapable = true;[^\n]*\ntry \{\s*isHdrCapable = webapis\.avinfo\.isHdrTvSupport\(\) !== false;\s*\} catch \(e\) \{/.test(index));
assert(/element\.id === 'hdrModeBtn' && !isHdrCapable/.test(navigation));

// The Game Mode switch is locked in the ForceGM variant. Upstream tests the function itself in one place, which is always true;
// here it is called everywhere
assert(!/checkForceGMVariant(?!\()/.test(index.replace(/function checkForceGMVariant\(\)/, '').replace(/\[index\.js, checkForceGMVariant\]/g, '')), 'checkForceGMVariant is always called');
assert(/\} else if \(checkForceGMVariant\(\) \|\| parseFloat\(platformVer\) === 5\.5\) \{/.test(index));
assert(/Never force Game Mode without an explicit user choice\s*if \(isForceGMVariant \|\| parseFloat\(platformVer\) === 5\.5\) \{/.test(index), 'the default of this fork stays: Game Mode is never switched on by itself');

// The stream menu of upstream (Play/Pause key) is left out: this fork has its own menu
for (const source of [index, navigation, html, messages]) {
  assert(!/StreamMenuDialog|streamMenuDialog|MediaPlayPause|isStreamMenuKey|getStreamMenuOptions/.test(source));
}
assert(/StreamMenu\.close\(\);/.test(messages));

// The languages of upstream are offered next to Polish. They do not have the strings of this fork, which then show in English,
// but they must not carry strings that the application no longer has
const locales = ['en-US', 'sq-AL', 'fr-FR', 'de-DE', 'it-IT', 'pl-PL', 'pt-BR', 'es-ES'];
assert(i18n.includes("'" + locales.join("', '") + "'"), 'the list of languages');
assert.deepStrictEqual(fs.readdirSync('wasm/static/locales').sort(), locales.map((locale) => locale + '.json').sort());
const english = JSON.parse(read('wasm/static/locales/en-US.json'));
for (const locale of locales) {
  const strings = JSON.parse(read('wasm/static/locales/' + locale + '.json'));
  assert.deepStrictEqual(Object.keys(strings).filter((key) => !(key in english)), [], locale + ' has no string that English lacks');
  assert(new RegExp("'" + locale + "': '[^']+'").test(i18n), locale + ' has a label');
}
for (const locale of ['pl-PL', 'pt-BR']) {
  const strings = JSON.parse(read('wasm/static/locales/' + locale + '.json'));
  assert.deepStrictEqual(Object.keys(english).filter((key) => !(key in strings)), [], locale + ' is complete');
}
assert(/const translated = state\.dictionary\[key\];\s*const source = state\.sourceDictionary\[key\];/.test(i18n), 'a missing string falls back to English');

console.log('upstream_v120_integration_tests: PASS');
