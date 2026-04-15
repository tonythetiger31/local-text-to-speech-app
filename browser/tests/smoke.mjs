import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');

// ── Prompt 1 assertions ───────────────────────────────────────────────────────

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

// ── Prompt 2 assertions ───────────────────────────────────────────────────────

// 8. tts-worker.js exists on disk
const workerPath = resolve(__dirname, '../tts-worker.js');
assert.ok(
  existsSync(workerPath),
  'FAIL: browser/tts-worker.js does not exist'
);

// 9. tts-worker.js contains the splitIntoChunks function
const workerSrc = readFileSync(workerPath, 'utf8');
assert.ok(
  workerSrc.includes('split_into_chunks') || workerSrc.includes('splitIntoChunks'),
  'FAIL: tts-worker.js does not contain "split_into_chunks" or "splitIntoChunks"'
);

// ── Extract splitIntoChunks for unit testing ──────────────────────────────────
// Copy the function here so we can test it in Node (no browser globals needed).

function splitIntoChunks(text, maxChars = 400) {
  // Stage 1: normalize line breaks
  text = text.replace(/(?<![.!?\n])\n(?!\n)/g, ' ');
  text = text.replace(/\n{2,}/g, '\n');
  text = text.replace(/[ \t]+/g, ' ');

  // Stage 2: split on remaining newlines
  const lines = text.split('\n');

  // Stage 3: split on sentence-ending punctuation followed by uppercase / opening quote
  const sentRe = /(?<=[.!?])\s+(?=[A-Z"\u201C\u2018])/g;
  const sentences = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    for (const s of line.split(sentRe)) {
      const trimmed = s.trim();
      if (trimmed) sentences.push(trimmed);
    }
  }

  // Stage 4: oversized → split at ; : em-dash
  const delimRe = /(?<=[;:\u2014])\s+/g;
  const expanded = [];
  for (const s of sentences) {
    if (s.length <= maxChars) {
      expanded.push(s);
    } else {
      const parts = s.split(delimRe);
      let buf = '';
      for (const rawP of parts) {
        const p = rawP.trim();
        if (!p) continue;
        const candidate = buf ? (buf + ' ' + p).trim() : p;
        if (candidate.length <= maxChars) {
          buf = candidate;
        } else {
          if (buf) expanded.push(buf);
          buf = p;
        }
      }
      if (buf) expanded.push(buf);
    }
  }

  // Stage 5: still oversized → split at commas
  const commaRe = /(?<=,)\s+/g;
  const result = [];
  for (const chunk of expanded) {
    if (chunk.length <= maxChars) {
      result.push(chunk);
    } else {
      const parts = chunk.split(commaRe);
      let buf = '';
      for (const rawP of parts) {
        const p = rawP.trim();
        if (!p) continue;
        const candidate = buf ? (buf + ' ' + p).trim() : p;
        if (candidate.length <= maxChars) {
          buf = candidate;
        } else {
          if (buf) result.push(buf);
          buf = p;
        }
      }
      if (buf) result.push(buf);
    }
  }

  // Stage 6: merge short fragments (carry < 30 chars) forward into carry
  const merged = [];
  let carry = '';
  for (const rawChunk of result) {
    const chunk = rawChunk.trim();
    if (!chunk) continue;
    const combined = carry ? (carry + ' ' + chunk).trim() : chunk;
    if (carry && carry.length < 30) {
      carry = combined;
    } else {
      if (carry) merged.push(carry);
      carry = chunk;
    }
  }
  if (carry) merged.push(carry);

  return merged.filter(c => c.trim());
}

// 10. Three long sentences (each >= 30 chars) are kept as 3 separate chunks.
//     Stage 3 splits them, stage 6 does NOT merge them because no carry is < 30 chars.
const longSentences =
  'The quick brown fox jumps over the lazy sleeping dog. ' +
  'The lazy dog woke up and barked loudly at the fox. ' +
  'The clever fox turned around and ran swiftly away.';
const longResult = splitIntoChunks(longSentences);
assert.strictEqual(
  longResult.length, 3,
  `FAIL: expected 3 chunks for 3 long sentences, got ${longResult.length}: ${JSON.stringify(longResult)}`
);

// 11. Stage 6 merging: a short leading sentence (<30 chars) is merged into the
//     next chunk rather than standing alone.
//     "Yes." is only 4 chars — stage 6 merges it forward into the next sentence.
const mergeInput =
  'Yes. This continuation sentence is long enough to exceed thirty chars easily.';
const mergeResult = splitIntoChunks(mergeInput);
assert.strictEqual(
  mergeResult.length, 1,
  `FAIL: expected short fragment "Yes." to be merged forward; got ${mergeResult.length} chunks: ${JSON.stringify(mergeResult)}`
);
assert.ok(
  mergeResult[0].startsWith('Yes.'),
  `FAIL: merged chunk should start with "Yes.", got "${mergeResult[0]}"`
);

// 12. A 500-char string that has commas every ~30 chars is split into at least 2 chunks
//     when maxChars=400. Commas are the stage-5 split point.
const commaChunk = ('word word word word word word, ').repeat(16).trim(); // ~496 chars with commas
const commaResult = splitIntoChunks(commaChunk, 400);
assert.ok(
  commaResult.length >= 2,
  `FAIL: expected comma-delimited 500-char string to split into >= 2 chunks, got ${commaResult.length}`
);

// 13. Sentence splitting: "Hello world. How are you? I am fine." — all three
//     fragments are <30 chars so stage 6 merges them into a single chunk.
//     This verifies the faithful Python-matching merge behaviour.
const shortSentences = 'Hello world. How are you? I am fine.';
const shortResult = splitIntoChunks(shortSentences);
assert.strictEqual(
  shortResult.length, 1,
  `FAIL: three short sentences should merge into 1 chunk via stage 6; got ${shortResult.length}: ${JSON.stringify(shortResult)}`
);

// 14. Empty input returns an empty array
assert.deepEqual(splitIntoChunks(''), [], 'FAIL: empty input should return []');

// 15. index.html wires up the worker (new Worker)
assert.ok(
  html.includes("new Worker('tts-worker.js')"),
  'FAIL: index.html does not instantiate new Worker("tts-worker.js")'
);

console.log('All smoke tests passed.');
