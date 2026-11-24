/**
 * Generate 300 staff keys: 100 x 6h, 100 x 12h, 100 x 24h
 * Usage: node scripts/generate-staff-keys.js
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STAFF_KEY_SECRET = process.env.VIOEDU_STAFF_KEY_SECRET;
if (!STAFF_KEY_SECRET) {
  console.error('Set VIOEDU_STAFF_KEY_SECRET in the environment before generating staff keys.');
  process.exit(1);
}
const OUT_DIR = path.join(__dirname, '..', 'keys');
const COUNTS = { 6: 100, 12: 100, 24: 100 };

function sign(ttlHours, serial) {
  return crypto
    .createHash('sha256')
    .update(`${STAFF_KEY_SECRET}|${ttlHours}|${serial}`)
    .digest('hex')
    .slice(0, 16);
}

function makeSerial() {
  return crypto.randomBytes(6).toString('hex');
}

function makeKey(ttlHours) {
  const serial = makeSerial();
  const sig = sign(ttlHours, serial);
  return `VIO1.${ttlHours}.${serial}.${sig}`;
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const all = [];
const byType = { 6: [], 12: [], 24: [] };

for (const [ttl, count] of Object.entries(COUNTS)) {
  const ttlHours = parseInt(ttl, 10);
  for (let i = 0; i < count; i++) {
    const key = makeKey(ttlHours);
    byType[ttlHours].push(key);
    all.push({ key, ttlHours, index: i + 1 });
  }
}

const whitelistLines = [
  '# VioEdu QA Staff Whitelist',
  '# Upload this file to GitHub and point extension staffWhitelistUrl to its raw URL.',
  '# One key per line. Remove a line to revoke that key.',
  `# Generated: ${new Date().toISOString()}`,
  `# Total: ${all.length} (100x6h + 100x12h + 100x24h)`,
  ''
];

for (const ttl of [6, 12, 24]) {
  whitelistLines.push(`# --- ${ttl}h (${byType[ttl].length}) ---`);
  byType[ttl].forEach(k => whitelistLines.push(k));
  whitelistLines.push('');
}

const inventoryLines = [
  'index,ttl_hours,key',
  ...all.map((row, i) => `${i + 1},${row.ttlHours},${row.key}`)
];

const whitelistPath = path.join(OUT_DIR, 'staff-whitelist.txt');
const inventoryPath = path.join(OUT_DIR, 'staff-keys-inventory.csv');
const byTypeDir = path.join(OUT_DIR, 'by-ttl');

if (!fs.existsSync(byTypeDir)) fs.mkdirSync(byTypeDir, { recursive: true });

fs.writeFileSync(whitelistPath, whitelistLines.join('\n'), 'utf8');
fs.writeFileSync(inventoryPath, inventoryLines.join('\n'), 'utf8');
for (const ttl of [6, 12, 24]) {
  fs.writeFileSync(path.join(byTypeDir, `keys-${ttl}h.txt`), byType[ttl].join('\n') + '\n', 'utf8');
}

console.log(`Generated ${all.length} keys`);
console.log(`Whitelist: ${whitelistPath}`);
console.log(`Inventory: ${inventoryPath}`);
console.log(`By TTL:    ${byTypeDir}`);
