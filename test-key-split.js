// Run this locally with: node test-key-split.js
// It does NOT need your real key. Paste your two PART1/PART2 strings below
// temporarily, run the script, delete them when done. This never gets
// committed or uploaded anywhere - it's just a local sanity check.

const PART1 = "PASTE_FIREBASE_PRIVATE_KEY_PART1_HERE";
const PART2 = "PASTE_FIREBASE_PRIVATE_KEY_PART2_HERE";

const reassembled = (PART1 + PART2).replace(/\\n/g, '\n');

console.log('--- Reassembled key preview ---');
console.log(reassembled.slice(0, 40) + ' ... ' + reassembled.slice(-40));
console.log('--- Checks ---');
console.log('Starts with BEGIN PRIVATE KEY header:', reassembled.startsWith('-----BEGIN PRIVATE KEY-----'));
console.log('Ends with END PRIVATE KEY footer:', reassembled.trim().endsWith('-----END PRIVATE KEY-----'));
console.log('Total length:', reassembled.length);
console.log('PART1 length:', PART1.length, '| PART2 length:', PART2.length);

if (PART1.length > 1000 || PART2.length > 1000) {
  console.log('WARNING: one part may still be too long for a 1023-char limit (counting the var name too).');
}
