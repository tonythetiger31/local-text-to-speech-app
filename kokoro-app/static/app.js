const textInput = document.getElementById('text-input');
const voiceSelect = document.getElementById('voice-select');
const speedSlider = document.getElementById('speed-slider');
const speedLabel = document.getElementById('speed-label');
const speakBtn = document.getElementById('speak-btn');
const stopBtn = document.getElementById('stop-btn');
const statusEl = document.getElementById('status');
const charCounter = document.getElementById('char-counter');
const progressSection = document.getElementById('progress-section');
const genLabel = document.getElementById('gen-label');
const genBarFill = document.getElementById('gen-bar-fill');
const playLabel = document.getElementById('play-label');
const playBarFill = document.getElementById('play-bar-fill');
const playTrack = document.getElementById('play-track');
const playbackControls = document.getElementById('playback-controls');
const playPauseBtn = document.getElementById('play-pause-btn');
const seekBackBtn = document.getElementById('seek-back-btn');
const seekFwdBtn = document.getElementById('seek-fwd-btn');
const expandBtn = document.getElementById('expand-btn');
const readalong = document.getElementById('readalong');

const MAX_CHARS = 100000;
const WARN_CHARS = 80000;

// --- State ---
let currentJobId = null;
let audioCtx = null;
let scheduledBuffers = [];   // { source, startTime, duration, buffer }
let chunkDurations = [];
let totalScheduledDuration = 0;
let playbackStartTime = 0;
let pausedAt = 0;
let isPlaying = false;
let isPaused = false;
let nextChunkIndex = 0;
let totalChunks = 0;
let generationDone = false;
let pollTimer = null;
let rafId = null;
let decodedBuffers = [];   // AudioBuffer per chunk index

// Read-along / collapse state
let chunkTexts = [];
let chunkSpanEls = [];
let wordSpansByChunk = [];
let activeChunkIndex = -1;
let originalTextareaHeight = 0;

// Playback rate (applied via Web Audio, not backend generation)
let playbackRate = 1.0;

// --- Voice preview state ---
let previewSource = null;
let previewCtx = null;

// --- Char counter ---
function updateCharCounter() {
    const len = textInput.value.length;
    charCounter.textContent = `${len} / ${MAX_CHARS} characters`;
    charCounter.className = len > WARN_CHARS ? 'warning' : '';
    speakBtn.disabled = len === 0 || len > MAX_CHARS;
}

textInput.addEventListener('input', updateCharCounter);
updateCharCounter();

speedSlider.addEventListener('input', () => {
    speedLabel.textContent = `Speed: ${parseFloat(speedSlider.value).toFixed(1)}x`;
});

// Apply speed change to live playback by rescheduling from current position
speedSlider.addEventListener('change', () => {
    const newRate = parseFloat(speedSlider.value);
    if (newRate === playbackRate) return;
    if ((isPlaying || isPaused) && audioCtx) {
        const pos = currentPosition(); // capture before updating rate
        playbackRate = newRate;
        seekTo(pos);
    } else {
        playbackRate = newRate;
    }
});

// --- Voice loading ---
async function loadVoices() {
    try {
        const res = await fetch('/voices');
        const voices = await res.json();
        voices.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            if (v === 'af_bella') opt.selected = true;
            voiceSelect.appendChild(opt);
        });
    } catch (err) {
        setStatus('Failed to load voices: ' + err.message, true);
    }
}

function setStatus(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.className = isError ? 'error' : '';
}

// --- Format seconds as M:SS ---
function fmt(s) {
    s = Math.max(0, Math.floor(s));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

// --- Split text into chunks, mirroring Python backend logic ---
function splitIntoChunks(text, maxChars = 400) {
    // Stage 1: normalize line breaks.
    // Single \n not after sentence punctuation = soft word-wrap → replace with space.
    // Single \n after .!? = real sentence break → keep.
    // Multiple \n = paragraph break → collapse to one \n.
    text = text.replace(/(?<![.!?\n])\n(?!\n)/g, ' ');
    text = text.replace(/\n{2,}/g, '\n');
    text = text.replace(/[ \t]+/g, ' ');  // collapse runs of spaces/tabs to one

    // Stage 2: split on remaining newlines (true sentence/paragraph boundaries)
    const lines = text.split('\n');

    // Stage 3: split each line into sentences.
    // Require uppercase or opening quote after .!? to avoid splitting
    // abbreviations like "Mr. Smith" or "U.S. Army".
    const sentRe = /(?<=[.!?])\s+(?=[A-Z"\u201C\u2018])/;
    const sentences = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        for (const s of trimmed.split(sentRe)) {
            const st = s.trim();
            if (st) sentences.push(st);
        }
    }

    // Stage 3: sentences over maxChars → split at ; : — (delimiter preserved)
    const expanded = [];
    for (const s of sentences) {
        if (s.length <= maxChars) {
            expanded.push(s);
        } else {
            const parts = s.split(/(?<=[;:\u2014])\s+/);
            let buf = '';
            for (const p of parts) {
                const pt = p.trim();
                if (!pt) continue;
                const candidate = buf ? (buf + ' ' + pt).trim() : pt;
                if (candidate.length <= maxChars) {
                    buf = candidate;
                } else {
                    if (buf) expanded.push(buf);
                    buf = pt;
                }
            }
            if (buf) expanded.push(buf);
        }
    }

    // Stage 4: still over maxChars → split at commas (comma preserved via lookbehind)
    const result = [];
    for (const chunk of expanded) {
        if (chunk.length <= maxChars) {
            result.push(chunk);
        } else {
            const parts = chunk.split(/(?<=,)\s+/);
            let buf = '';
            for (const p of parts) {
                const pt = p.trim();
                if (!pt) continue;
                const candidate = buf ? (buf + ' ' + pt).trim() : pt;
                if (candidate.length <= maxChars) {
                    buf = candidate;
                } else {
                    if (buf) result.push(buf);
                    buf = pt;
                }
            }
            if (buf) result.push(buf);
        }
    }

    // Stage 5: merge short fragments (< 30 chars) forward into carry
    const merged = [];
    let carry = '';
    for (const chunk of result) {
        const c = chunk.trim();
        if (!c) continue;
        const combined = carry ? (carry + ' ' + c).trim() : c;
        if (carry && carry.length < 30) {
            carry = combined;
        } else {
            if (carry) merged.push(carry);
            carry = c;
        }
    }
    if (carry) merged.push(carry);

    return merged.filter(c => c.length > 0);
}

// --- Render the read-along panel from chunkTexts ---
function renderReadalong() {
    readalong.innerHTML = '';
    chunkSpanEls = [];
    wordSpansByChunk = [];

    chunkTexts.forEach((text) => {
        const chunkSpan = document.createElement('span');
        chunkSpan.className = 'chunk';

        const words = text.split(/\s+/).filter(w => w.length > 0);
        const wordSpans = [];

        words.forEach((word, wi) => {
            if (wi > 0) chunkSpan.appendChild(document.createTextNode(' '));
            const wordSpan = document.createElement('span');
            wordSpan.className = 'word';
            wordSpan.textContent = word;
            chunkSpan.appendChild(wordSpan);
            wordSpans.push(wordSpan);
        });

        readalong.appendChild(chunkSpan);
        readalong.appendChild(document.createTextNode(' '));

        chunkSpanEls.push(chunkSpan);
        wordSpansByChunk.push(wordSpans);
    });
}

// --- Collapse textarea to 3em ---
function collapseTextarea() {
    originalTextareaHeight = textInput.offsetHeight;
    // Pin height explicitly so the transition has a known start value
    textInput.style.height = originalTextareaHeight + 'px';
    textInput.style.minHeight = '0';
    textInput.style.overflow = 'hidden';
    textInput.style.resize = 'none';
    // Yield one frame so the browser registers the fixed height, then animate
    requestAnimationFrame(() => {
        textInput.style.height = '3em';
    });
    expandBtn.style.display = 'block';
}

// --- Expand textarea back to original height ---
function expandTextarea() {
    textInput.style.height = originalTextareaHeight + 'px';
    expandBtn.style.display = 'none';
    // After transition ends, restore natural sizing
    setTimeout(() => {
        textInput.style.height = '';
        textInput.style.minHeight = '';
        textInput.style.overflow = '';
        textInput.style.resize = '';
    }, 320);
}

// --- Remove all highlight classes ---
function clearHighlights() {
    readalong.querySelectorAll('.active-sentence').forEach(el => el.classList.remove('active-sentence'));
    readalong.querySelectorAll('.active-word').forEach(el => el.classList.remove('active-word'));
    activeChunkIndex = -1;
}

// --- Reset all state ---
function resetState() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

    // Stop all scheduled sources
    for (const entry of scheduledBuffers) {
        try { entry.source.stop(); } catch (_) { }
        entry.source.disconnect();
    }

    scheduledBuffers = [];
    chunkDurations = [];
    decodedBuffers = [];
    totalScheduledDuration = 0;
    playbackStartTime = 0;
    pausedAt = 0;
    isPlaying = false;
    isPaused = false;
    nextChunkIndex = 0;
    totalChunks = 0;
    generationDone = false;
    currentJobId = null;

    chunkTexts = [];
    chunkSpanEls = [];
    wordSpansByChunk = [];
    activeChunkIndex = -1;
}

// --- Current playback position in content-time seconds ---
// Wall-clock elapsed * playbackRate = content position
function currentPosition() {
    if (!audioCtx) return 0;
    if (isPaused) return pausedAt;
    const wallElapsed = audioCtx.currentTime - playbackStartTime;
    return Math.min(wallElapsed * playbackRate, totalScheduledDuration);
}

// --- AnimationFrame loop for playback progress + read-along highlighting ---
function startRaf() {
    function tick() {
        if (!isPlaying && !isPaused) return;
        const pos = currentPosition();
        const total = totalScheduledDuration || 1;
        const pct = Math.min((pos / total) * 100, 100);
        playBarFill.style.width = pct + '%';
        playLabel.textContent = `Playing: ${fmt(pos)} / ${fmt(totalScheduledDuration)}`;

        // --- Read-along highlighting ---
        if (chunkTexts.length > 0 && chunkDurations.length > 0) {
            const ct = Math.max(0, Math.min((audioCtx.currentTime - playbackStartTime) * playbackRate, totalScheduledDuration));

            let newActiveChunk = -1;
            let posWithinChunk = 0;
            let acc = 0;
            for (let i = 0; i < chunkDurations.length; i++) {
                const dur = chunkDurations[i] || 0;
                if (ct >= acc && ct < acc + dur) {
                    newActiveChunk = i;
                    posWithinChunk = ct - acc;
                    break;
                }
                acc += dur;
            }
            // If past all decoded chunks, stay on the last known one
            if (newActiveChunk === -1 && chunkDurations.length > 0) {
                newActiveChunk = chunkDurations.length - 1;
                posWithinChunk = chunkDurations[newActiveChunk] || 0;
            }

            // Update sentence highlight when chunk changes
            if (newActiveChunk !== activeChunkIndex) {
                // Clear old chunk
                if (activeChunkIndex >= 0) {
                    if (chunkSpanEls[activeChunkIndex]) {
                        chunkSpanEls[activeChunkIndex].classList.remove('active-sentence');
                    }
                    if (wordSpansByChunk[activeChunkIndex]) {
                        wordSpansByChunk[activeChunkIndex].forEach(ws => ws.classList.remove('active-word'));
                    }
                }
                activeChunkIndex = newActiveChunk;
                if (activeChunkIndex >= 0 && chunkSpanEls[activeChunkIndex]) {
                    chunkSpanEls[activeChunkIndex].classList.add('active-sentence');
                    chunkSpanEls[activeChunkIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }

            // Update word highlight within active chunk
            if (activeChunkIndex >= 0 && wordSpansByChunk[activeChunkIndex]) {
                const words = wordSpansByChunk[activeChunkIndex];
                if (words.length > 0) {
                    const chunkDur = chunkDurations[activeChunkIndex] || 1;
                    const wordDur = chunkDur / words.length;
                    const wordIdx = Math.min(Math.floor(posWithinChunk / wordDur), words.length - 1);
                    words.forEach((ws, wi) => {
                        if (wi === wordIdx) ws.classList.add('active-word');
                        else ws.classList.remove('active-word');
                    });
                }
            }
        }

        rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
}

// --- Schedule a single decoded buffer at a given wall-clock start time ---
function scheduleBuffer(buffer, chunkIdx, startTime) {
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    source.connect(audioCtx.destination);
    source.start(startTime);
    scheduledBuffers.push({ source, startTime, duration: buffer.duration, buffer });
}

// --- Fetch and schedule chunk ---
async function fetchAndScheduleChunk(jobId, index) {
    const res = await fetch(`/job/${jobId}/chunk/${index}`);
    if (!res.ok) throw new Error(`Chunk ${index} fetch failed: ${res.status}`);
    const arrayBuf = await res.arrayBuffer();
    const audioBuf = await audioCtx.decodeAudioData(arrayBuf);

    // Store decoded buffer for potential re-scheduling after seek
    decodedBuffers[index] = audioBuf;
    chunkDurations[index] = audioBuf.duration;

    // contentOffset = sum of all previous chunk durations (content-time)
    let contentOffset = 0;
    for (let i = 0; i < index; i++) {
        contentOffset += chunkDurations[i] || 0;
    }

    // totalScheduledDuration stays in content-time throughout
    totalScheduledDuration = contentOffset + audioBuf.duration;

    if (!isPlaying && !isPaused) {
        // First chunk: begin playback
        playbackStartTime = audioCtx.currentTime;
        isPlaying = true;
        playbackControls.style.display = 'flex';
        startRaf();
    }

    // Wall-clock start = playbackStartTime + contentOffset / rate
    const absStart = playbackStartTime + contentOffset / playbackRate;
    scheduleBuffer(audioBuf, index, absStart);
}

// --- Update generation progress bar ---
function updateGenBar(ready, total) {
    genLabel.textContent = `Generating: ${ready} of ${total} chunks`;
    const pct = total > 0 ? (ready / total) * 100 : 0;
    genBarFill.style.width = pct + '%';
}

// --- Polling loop ---
async function pollStatus(jobId) {
    try {
        const res = await fetch(`/job/${jobId}/status`);
        if (!res.ok) return;
        const data = await res.json();

        if (jobId !== currentJobId) return; // stale poll

        updateGenBar(data.ready, data.total);

        // Fetch any newly ready chunks
        while (nextChunkIndex < data.ready) {
            const idx = nextChunkIndex;
            nextChunkIndex++;
            // Fire-and-forget fetch; errors are non-fatal per chunk
            fetchAndScheduleChunk(jobId, idx).catch(err => {
                console.warn('Chunk fetch error:', err);
            });
        }

        if (data.done) {
            generationDone = true;
            clearInterval(pollTimer);
            pollTimer = null;
            setStatus('');
        }
    } catch (err) {
        console.warn('Poll error:', err);
    }
}

// --- Seek to a target position in seconds ---
function seekTo(targetSec) {
    if (!audioCtx) return;
    targetSec = Math.max(0, Math.min(targetSec, totalScheduledDuration));

    // Stop and disconnect all current sources
    for (const entry of scheduledBuffers) {
        try { entry.source.stop(); } catch (_) { }
        entry.source.disconnect();
    }
    scheduledBuffers = [];

    // Find which chunk contains targetSec and the offset within it
    let accumulated = 0;
    let startChunkIdx = 0;
    let offsetWithinChunk = 0;

    for (let i = 0; i < decodedBuffers.length; i++) {
        const dur = chunkDurations[i] || 0;
        if (accumulated + dur > targetSec) {
            startChunkIdx = i;
            offsetWithinChunk = targetSec - accumulated;
            break;
        }
        accumulated += dur;
        // If we've exhausted all chunks, clamp to end of last chunk
        if (i === decodedBuffers.length - 1) {
            startChunkIdx = i;
            offsetWithinChunk = dur;
        }
    }

    // playbackStartTime anchors the wall-clock origin so that:
    //   contentPosition = (audioCtx.currentTime - playbackStartTime) * playbackRate
    playbackStartTime = audioCtx.currentTime - targetSec / playbackRate;
    if (isPaused) {
        pausedAt = targetSec;
    }

    // Re-schedule all chunks from startChunkIdx onwards
    for (let i = startChunkIdx; i < decodedBuffers.length; i++) {
        if (!decodedBuffers[i]) continue;
        const buf = decodedBuffers[i];
        const chunkContentStart = (() => {
            let s = 0;
            for (let j = 0; j < i; j++) s += chunkDurations[j] || 0;
            return s;
        })();

        const source = audioCtx.createBufferSource();
        source.buffer = buf;
        source.playbackRate.value = playbackRate;
        source.connect(audioCtx.destination);

        // Wall-clock absolute start for this chunk
        const absStart = playbackStartTime + chunkContentStart / playbackRate;

        if (i === startChunkIdx && offsetWithinChunk > 0) {
            // Start partway through this chunk (offsetWithinChunk is in content-time / buffer frames)
            source.start(audioCtx.currentTime, offsetWithinChunk, buf.duration - offsetWithinChunk);
        } else {
            source.start(Math.max(audioCtx.currentTime, absStart));
        }

        scheduledBuffers.push({ source, startTime: absStart, duration: buf.duration, buffer: buf });
    }
}

// --- Speak ---
async function speak() {
    const text = textInput.value.trim();
    const voice = voiceSelect.value;
    // Speed is controlled via Web Audio playbackRate, not baked into generation.
    // Always generate at 1.0x so the rate can be changed freely during playback.
    playbackRate = parseFloat(speedSlider.value);

    if (!text) {
        setStatus('Please enter some text first.', true);
        return;
    }

    // Build chunk texts before resetting state (used for readalong render)
    chunkTexts = splitIntoChunks(text);

    // If a previous job is running, stop it
    if (currentJobId) {
        const prevId = currentJobId;
        resetState();
        fetch(`/job/${prevId}`, { method: 'DELETE' }).catch(() => { });
    } else {
        resetState();
    }

    // Restore chunkTexts after resetState cleared it
    chunkTexts = splitIntoChunks(text);

    // Resume or create AudioContext
    if (!audioCtx) {
        audioCtx = new AudioContext();
    } else if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }

    speakBtn.disabled = true;
    progressSection.style.display = 'flex';
    playbackControls.style.display = 'none';
    playPauseBtn.textContent = '⏸';
    genBarFill.style.width = '0%';
    playBarFill.style.width = '0%';
    playLabel.textContent = 'Playing: 0:00 / 0:00';
    setStatus('Generating...');

    // Collapse textarea and show read-along panel
    collapseTextarea();
    renderReadalong();
    readalong.style.display = 'block';

    try {
        const res = await fetch('/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice, speed: 1.0 }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || res.statusText);
        }

        const data = await res.json();
        currentJobId = data.job_id;
        totalChunks = data.total_chunks;
        updateGenBar(0, totalChunks);

        // Start polling
        pollTimer = setInterval(() => pollStatus(currentJobId), 800);
        // Poll immediately
        pollStatus(currentJobId);

    } catch (err) {
        setStatus('Error: ' + err.message, true);
        progressSection.style.display = 'none';
        updateCharCounter();
    }
}

// --- Stop ---
async function stop() {
    const jobId = currentJobId;

    // Suspend audio context if active
    if (audioCtx && audioCtx.state === 'running') {
        await audioCtx.suspend();
    }

    clearHighlights();
    resetState();

    if (jobId) {
        fetch(`/job/${jobId}`, { method: 'DELETE' }).catch(() => { });
    }

    progressSection.style.display = 'none';
    playbackControls.style.display = 'none';
    playPauseBtn.textContent = '⏸';
    setStatus('');
    updateCharCounter();

    // Re-expand textarea and hide read-along
    expandTextarea();
    readalong.style.display = 'none';
}

// --- Expand button: restore textarea without stopping playback ---
expandBtn.addEventListener('click', () => {
    expandTextarea();
});

// --- Play / Pause ---
playPauseBtn.addEventListener('click', async () => {
    if (!audioCtx) return;

    if (isPaused) {
        // Resume — recalculate anchor so content position stays correct
        await audioCtx.resume();
        playbackStartTime = audioCtx.currentTime - pausedAt / playbackRate;
        isPaused = false;
        isPlaying = true;
        playPauseBtn.textContent = '⏸';
        startRaf();
    } else if (isPlaying) {
        // Pause
        pausedAt = currentPosition();
        await audioCtx.suspend();
        isPlaying = false;
        isPaused = true;
        playPauseBtn.textContent = '▶';
    }
});

// --- Seek −10s ---
seekBackBtn.addEventListener('click', () => {
    const target = currentPosition() - 10;
    seekTo(target);
});

// --- Seek +10s ---
seekFwdBtn.addEventListener('click', () => {
    const target = currentPosition() + 10;
    seekTo(target);
});

// --- Click on playback bar to seek ---
playTrack.addEventListener('click', (e) => {
    if (!audioCtx || totalScheduledDuration === 0) return;
    const rect = playTrack.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    seekTo(fraction * totalScheduledDuration);
});

// --- Speak / Stop buttons ---
speakBtn.addEventListener('click', speak);
stopBtn.addEventListener('click', stop);

// --- Cmd+Enter / Ctrl+Enter ---
textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (!speakBtn.disabled) speak();
    }
});

// --- Voice preview on dropdown change ---
voiceSelect.addEventListener('change', async () => {
    const voice = voiceSelect.value;
    if (!voice) return;

    // Stop any preview already in flight
    if (previewSource) {
        try { previewSource.stop(); } catch (_) {}
        previewSource.disconnect();
        previewSource = null;
    }

    voiceSelect.classList.add('previewing');

    try {
        const res = await fetch('/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voice }),
        });
        if (!res.ok) {
            voiceSelect.classList.remove('previewing');
            return;
        }
        const arrayBuf = await res.arrayBuffer();

        // Reuse the main audioCtx if it's already running; otherwise use a
        // dedicated preview context so we never unsuspend a paused playback.
        let ctx;
        if (audioCtx && audioCtx.state === 'running') {
            ctx = audioCtx;
        } else {
            if (!previewCtx || previewCtx.state === 'closed') {
                previewCtx = new AudioContext();
            } else if (previewCtx.state === 'suspended') {
                await previewCtx.resume();
            }
            ctx = previewCtx;
        }

        const audioBuf = await ctx.decodeAudioData(arrayBuf);

        // Remove dim now that audio is ready to start
        voiceSelect.classList.remove('previewing');

        // Stop a preview that may have started while we were awaiting
        if (previewSource) {
            try { previewSource.stop(); } catch (_) {}
            previewSource.disconnect();
        }

        const src = ctx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(ctx.destination);
        src.start();
        previewSource = src;
        src.onended = () => { if (previewSource === src) previewSource = null; };
    } catch (err) {
        voiceSelect.classList.remove('previewing');
        console.warn('Preview error:', err);
    }
});

loadVoices();
