import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');

// 1. References kokoro-js CDN package
assert.ok(
  html.includes('kokoro-js'),
  'FAIL: html does not contain "kokoro-js"'
);

// 2. Contains a <select> element (voice dropdown)
assert.ok(
  html.includes('<select'),
  'FAIL: html does not contain a <select> element'
);

// 3. Contains an element with id="generate-btn"
assert.ok(
  html.includes('id="generate-btn"'),
  'FAIL: html does not contain an element with id="generate-btn"'
);

// 4. Contains a <div for the read-along panel (id="readalong")
assert.ok(
  html.includes('id="readalong"'),
  'FAIL: html does not contain a <div id="readalong">'
);

// 5. Contains a preview button
assert.ok(
  html.includes('id="preview-btn"'),
  'FAIL: html does not contain an element with id="preview-btn"'
);

// 6. Loading banner is present
assert.ok(
  html.includes('id="loading-banner"'),
  'FAIL: html does not contain id="loading-banner"'
);

// 7. KokoroTTS import is present
assert.ok(
  html.includes('KokoroTTS'),
  'FAIL: html does not import KokoroTTS'
);

console.log('All smoke tests passed.');
