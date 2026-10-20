'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const start = read('tools/Start-QosThrottle.ps1');
const stop = read('tools/Stop-QosThrottle.ps1');

// Windows PowerShell 5.1 reads a script without a byte order mark as ANSI: a character outside ASCII would be garbled
for (const [name, text] of [['Start-QosThrottle.ps1', start], ['Stop-QosThrottle.ps1', stop]]) {
  assert(!/[^\x00-\x7F]/.test(text), name + ' is plain ASCII');
  assert(/\[switch\]\$DryRun/.test(text), name + ' has a dry run that changes nothing');
  assert(/IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/.test(text), name + ' checks for administrator rights');
}

// Both scripts name the same policy by default, so that the second one removes what the first one made
const nameOf = (text) => /\[string\]\$PolicyName = '([^']+)'/.exec(text)[1];
assert.strictEqual(nameOf(start), nameOf(stop));

// The limit is on the traffic to the TV only, and is never left behind by the script that made it
assert(/-IPDstPrefixMatchCondition \$prefix/.test(start));
assert(/\$prefix = "\$TvAddress\/32"/.test(start), 'one host, not a network');
assert(/-ThrottleRateActionBitsPerSecond \$bitsPerSecond/.test(start));
assert(/finally\s*\{\s*Remove-NetQosPolicy -Name \$PolicyName/.test(start), 'the policy is removed when the time is up, on Ctrl+C and on an error');
assert(/\[ValidateRange\(0, 1440\)\]\[int\]\$Minutes = 30/.test(start), 'it removes the policy by itself after 30 minutes unless told otherwise');

// The address is validated before anything is created
assert(/AddressFamily -ne \[System\.Net\.Sockets\.AddressFamily\]::InterNetwork/.test(start));
assert(start.indexOf('is not an IPv4 address') < start.indexOf('New-NetQosPolicy -Name'));

// The stop script removes from both stores and reports a policy that is still in effect
assert(/Remove-NetQosPolicy -Name \$PolicyName -Confirm:\$false/.test(stop));
assert(/Remove-NetQosPolicy -Name \$PolicyName -PolicyStore ActiveStore/.test(stop));
assert(/still in effect/.test(stop));

console.log('qos throttle scripts tests passed');
