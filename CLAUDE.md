# Kokoro TTS — Local Text-to-Speech Web App

## What This Is

A locally-hosted text-to-speech website powered by [Kokoro TTS](https://github.com/hexgrad/kokoro).
Paste any text (up to 100,000 characters), pick a voice, and it reads it back to you.

The defining feature is **streaming batched synthesis**: instead of waiting for the entire text to
be converted before audio starts, the backend processes the text in sentence-sized chunks and the
frontend begins playing the first chunk as soon as it's ready. Long documents start playing in
seconds rather than minutes.

Other notable features:
- **28 voice options** — American and British accents, male and female
- **Voice preview** — play a short greeting clip for any voice before committing to it
- **Playback speed control** — 0.5× to 2.0×, adjustable live during playback via Web Audio API
  (speed is not baked into synthesis; it's applied client-side so it can change freely)
- **Read-along highlighting** — the current sentence is highlighted in a panel and individual
  words are highlighted proportionally as the audio plays through each chunk
- **Seek controls** — click the progress bar or use ±10s buttons to jump around
- **Textarea collapse** — the input collapses to a compact strip once playback starts, replaced by
  the read-along panel; an "Edit text" button restores it without interrupting audio

---

## Project Structure

```
├── app.py               # Flask backend
├── requirements.txt     # Python dependencies
├── docker-compose.yml   # Docker deployment config
├── Dockerfile           # Container build definition
├── test_app.py          # Pytest integration tests
├── static/
│   ├── app.js           # Frontend JS (Web Audio API, playback, read-along)
│   └── style.css        # Frontend styles
└── templates/
    └── index.html       # HTML shell (loads app.js and style.css)
```

---

## Key Files

### `app.py`

The Flask server. Runs on port 5050.

**`voice_id_to_name(voice_id)`**
Converts a voice ID like `af_alloy` to a human-readable name like `American Female Alloy`.
Used by the `/preview` endpoint to generate a personalized greeting.

**`split_into_chunks(text, max_chars=400)`**
Splits input text into synthesis-ready segments in six stages:
1. Normalize line breaks — soft wraps (single `\n` not after `.!?`) become spaces; multiple `\n` collapse to one.
2. Split on remaining newlines (true paragraph/sentence boundaries).
3. Split each line on sentence-ending punctuation, requiring an uppercase letter or opening quote to follow (avoids splitting on abbreviations like "Mr. Smith").
4. Split any segment still over `max_chars` at `;`, `:`, or em-dash.
5. Split remaining oversized segments at commas.
6. Merge short fragments (< 30 chars) forward into the accumulating carry.

**`_synthesize_job(job_id, chunk_list, voice, speed)`**
Runs in a background `threading.Thread`. Iterates over the chunk list, calls the Kokoro
`KPipeline` for each, concatenates the resulting numpy audio arrays, encodes them to WAV via
`soundfile`, and appends the raw bytes to the job's chunk list in a thread-safe way using
`jobs_lock`. Sets `done=True` when finished or `error` on exception.

**API endpoints:**
| Route | Method | Purpose |
|---|---|---|
| `POST /speak` | — | Creates a job, starts background synthesis thread, returns `job_id` + `total_chunks` |
| `GET /job/<id>/status` | — | Returns `{ ready, total, done, error }` so the frontend can poll |
| `GET /job/<id>/chunk/<n>` | — | Returns the nth WAV chunk as `audio/wav` once ready |
| `DELETE /job/<id>` | — | Frees job memory when the user stops or starts a new session |
| `GET /voices` | — | Returns the static list of 28 supported voice IDs |
| `POST /preview` | — | Synthesizes a short personalized greeting for the given voice, returns `audio/wav` |

Jobs are stored in a plain Python dict (`jobs`) protected by a `threading.Lock`.

---

### `static/app.js`

The frontend logic — no build step, no framework, vanilla JS using the **Web Audio API**.

**Polling loop (`pollStatus`)** — runs every 800ms via `setInterval`. Fetches `/job/<id>/status`,
then for each newly ready chunk index calls `fetchAndScheduleChunk`.

**`fetchAndScheduleChunk(jobId, index)`** — fetches the WAV bytes, decodes them into an
`AudioBuffer` via `audioCtx.decodeAudioData`, calculates the correct wall-clock start time based
on the sum of all preceding chunk durations, and calls `audioCtx.createBufferSource().start()`.
This is how streaming playback works: chunks are scheduled into the Web Audio graph as they
arrive, each starting exactly after the previous one ends.

**Seek (`seekTo(targetSec)`)** — stops and disconnects all scheduled `AudioBufferSourceNode`s,
re-derives which chunk the target time falls in, and re-schedules everything from that point.
Decoded buffers are cached in `decodedBuffers[]` so re-seeking doesn't require re-fetching.

**Speed changes** — `playbackRate` is set on each `AudioBufferSourceNode` and also on the
`playbackStartTime` anchor math. Changing speed mid-playback calls `seekTo(currentPosition())`
with the new rate, effectively rescheduling all sources at the new rate from the current position.

**Read-along** — `renderReadalong()` wraps every word in a `<span class="word">`. The
`requestAnimationFrame` loop computes which chunk is playing based on cumulative durations, marks
that chunk's `<span>` as `active-sentence`, and linearly interpolates which word within the chunk
should be `active-word` based on elapsed time / chunk duration / word count.

---

### `requirements.txt`

```
flask, flask-cors, kokoro>=0.9.2, soundfile, numpy, pytest
```

---

### `docker-compose.yml`

Single-service compose file. Builds the local `Dockerfile`, maps port `5050:5050`, restarts
unless stopped.

---

### `test_app.py`

Pytest integration tests using Flask's test client. Covers: valid/invalid `/speak` payloads
(including the 100,000-character limit), job status polling, chunk retrieval (polls until
`done=True`, then asserts `audio/wav`), `split_into_chunks` behavior, basic UI assertions on
the rendered index page, `voice_id_to_name` conversions, and `/preview` endpoint (valid voice,
missing voice, unknown voice).
