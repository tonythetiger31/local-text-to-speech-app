// tts-worker.js — Classic Web Worker: owns KokoroTTS model + chunked synthesis.
// Loaded via new Worker('tts-worker.js') — no module worker, no importScripts.
// Uses dynamic import() for the ESM CDN package (supported in all modern browsers).

let tts = null;
let cancelled = false;

// ── WAV encoder (Float32Array → ArrayBuffer) ──────────────────────────────────
function encodeWAV(samples, sampleRate) {
  const numSamples = samples.length;
  const buf = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buf);

  function writeStr(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);            // chunk size
  view.setUint16(20, 1, true);             // PCM
  view.setUint16(22, 1, true);             // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);             // block align
  view.setUint16(34, 16, true);            // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return buf;
}

// ── splitIntoChunks — faithful JS port of app.py split_into_chunks ────────────
//
// Six stages (matching the Python implementation exactly):
//   1. Normalize line breaks: soft-wraps → spaces, multiple \n → one \n.
//   2. Split on remaining \n (true paragraph/sentence boundaries).
//   3. Split on sentence-ending punctuation followed by uppercase or opening quote.
//   4. Split oversized segments (> maxChars) at ; : or em-dash.
//   5. Split still-oversized segments at commas.
//   6. Merge short fragments (carry < 30 chars) forward into carry.
//
function splitIntoChunks(text, maxChars = 400) {
  // Stage 1: normalize line breaks
  // Single \n not after sentence-end → soft word-wrap → space
  text = text.replace(/(?<![.!?\n])\n(?!\n)/g, ' ');
  // Multiple \n → single \n
  text = text.replace(/\n{2,}/g, '\n');
  // Collapse runs of spaces/tabs
  text = text.replace(/[ \t]+/g, ' ');

  // Stage 2: split on remaining newlines
  const lines = text.split('\n');

  // Stage 3: split each line on sentence-ending punctuation.
  // Require uppercase or opening quote to follow so abbreviations like
  // "Mr. Smith" or "U.S. Army" are not treated as sentence boundaries.
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

  // Stage 4: sentences still over maxChars → split at ; : — (delimiter preserved)
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

  // Stage 5: still over maxChars → split at commas (comma preserved via lookbehind)
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

// ── Message handler ───────────────────────────────────────────────────────────
self.onmessage = async function (e) {
  const { type } = e.data;

  if (type === 'init') {
    try {
      const { KokoroTTS } = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1/dist/kokoro.web.js');
      tts = await KokoroTTS.from_pretrained(
        'onnx-community/Kokoro-82M-v1.0-ONNX',
        { dtype: 'q8', device: 'wasm' }
      );
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message });
    }

  } else if (type === 'synthesize') {
    cancelled = false;
    // Main thread pre-splits and sends the full chunk array.
    // Each worker only synthesizes its assigned indices (round-robin by workerIdx).
    const { chunks, workerIdx, voice, speed } = e.data;
    const total = chunks.length;

    for (let i = 0; i < total; i++) {
      if (i % 2 !== workerIdx) continue;
      if (cancelled) break;

      const chunkText = chunks[i];
      try {
        const output = await tts.generate(chunkText, { voice });

        // Encode result to WAV ArrayBuffer
        let buffer;
        if (typeof output.toWav === 'function') {
          const wav = output.toWav();
          buffer = wav instanceof ArrayBuffer ? wav : wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
        } else {
          const samples = output.audio ?? output.data ?? output;
          const rate = output.sampling_rate ?? output.sampleRate ?? 24000;
          const arr = samples instanceof Float32Array ? samples : new Float32Array(samples);
          buffer = encodeWAV(arr, rate);
        }

        // Transfer buffer to main thread (zero-copy)
        self.postMessage({ type: 'chunk', index: i, total, buffer, chunkText }, [buffer]);
      } catch (err) {
        self.postMessage({ type: 'error', message: err.message, index: i });
        return;
      }
    }

    if (!cancelled) {
      self.postMessage({ type: 'done' });
    }

  } else if (type === 'cancel') {
    cancelled = true;
  }
};
