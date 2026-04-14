import io
import re
import uuid
import threading
import numpy as np
import soundfile as sf
from flask import Flask, request, jsonify, send_file, render_template
from flask_cors import CORS
from kokoro import KPipeline

app = Flask(__name__)
CORS(app)

pipeline = KPipeline(lang_code='a')

jobs = {}  # { job_id: { "chunks": [], "total": int, "done": bool, "error": str|None } }
jobs_lock = threading.Lock()

VOICES = [
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica",
    "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis"
]


def split_into_chunks(text, max_chars=400):
    # Stage 1: normalize line breaks.
    # Single \n not preceded by sentence-ending punctuation is a soft word-wrap
    # (e.g. text copied from a PDF or formatted document) — replace with a space.
    # Single \n after .!? is a real sentence break — leave it.
    # Multiple \n (blank lines) are paragraph breaks — collapse to one \n.
    text = re.sub(r'(?<![.!?\n])\n(?!\n)', ' ', text)
    text = re.sub(r'\n{2,}', '\n', text)
    text = re.sub(r'[ \t]+', ' ', text)  # collapse runs of spaces/tabs to one

    # Stage 2: split on the remaining newlines (true sentence/paragraph boundaries)
    lines = text.split('\n')

    # Stage 3: split each line into sentences.
    # Require an uppercase letter or opening quote after .!? so abbreviations
    # like "Mr. Smith" or "U.S. Army" are not treated as sentence boundaries.
    sent_re = re.compile(r'(?<=[.!?])\s+(?=[A-Z\"\u201C\u2018])')
    sentences = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        for s in sent_re.split(line):
            s = s.strip()
            if s:
                sentences.append(s)

    # Stage 4: sentences still over max_chars → split at ; : — (delimiter preserved)
    expanded = []
    for s in sentences:
        if len(s) <= max_chars:
            expanded.append(s)
        else:
            parts = re.split(r'(?<=[;:\u2014])\s+', s)
            buf = ''
            for p in parts:
                p = p.strip()
                if not p:
                    continue
                candidate = (buf + ' ' + p).strip() if buf else p
                if len(candidate) <= max_chars:
                    buf = candidate
                else:
                    if buf:
                        expanded.append(buf)
                    buf = p
            if buf:
                expanded.append(buf)

    # Stage 5: still over max_chars → split at commas (comma preserved via lookbehind)
    result = []
    for chunk in expanded:
        if len(chunk) <= max_chars:
            result.append(chunk)
        else:
            parts = re.split(r'(?<=,)\s+', chunk)
            buf = ''
            for p in parts:
                p = p.strip()
                if not p:
                    continue
                candidate = (buf + ' ' + p).strip() if buf else p
                if len(candidate) <= max_chars:
                    buf = candidate
                else:
                    if buf:
                        result.append(buf)
                    buf = p
            if buf:
                result.append(buf)

    # Stage 6: merge short fragments (< 30 chars) forward into the accumulating carry
    merged = []
    carry = ''
    for chunk in result:
        chunk = chunk.strip()
        if not chunk:
            continue
        combined = (carry + ' ' + chunk).strip() if carry else chunk
        if carry and len(carry) < 30:
            carry = combined
        else:
            if carry:
                merged.append(carry)
            carry = chunk
    if carry:
        merged.append(carry)

    return [c for c in merged if c.strip()]


def _synthesize_job(job_id, chunk_list, voice, speed):
    try:
        for chunk_text in chunk_list:
            audio_parts = []
            for _, _, audio in pipeline(chunk_text, voice=voice, speed=speed):
                if audio is not None:
                    audio_parts.append(audio)

            if audio_parts:
                audio_data = np.concatenate(audio_parts)
            else:
                audio_data = np.array([], dtype=np.float32)

            buffer = io.BytesIO()
            sf.write(buffer, audio_data, 24000, format='WAV')
            wav_bytes = buffer.getvalue()

            with jobs_lock:
                jobs[job_id]["chunks"].append(wav_bytes)

        with jobs_lock:
            jobs[job_id]["done"] = True
    except Exception as e:
        with jobs_lock:
            jobs[job_id]["error"] = str(e)
            jobs[job_id]["done"] = True


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/voices')
def voices():
    return jsonify(VOICES)


@app.route('/speak', methods=['POST'])
def speak():
    data = request.get_json(silent=True) or {}

    text = data.get('text', '').strip()
    if not text:
        return jsonify({'error': 'text is required and must be non-empty'}), 400

    if len(text) > 100000:
        return jsonify({'error': 'Text too long. Maximum 100000 characters.'}), 400

    voice = data.get('voice', 'af_bella')
    speed = float(data.get('speed', 1.0))

    chunk_list = split_into_chunks(text)
    if not chunk_list:
        chunk_list = [text]

    job_id = str(uuid.uuid4())
    job = {"chunks": [], "total": len(chunk_list), "done": False, "error": None}

    with jobs_lock:
        jobs[job_id] = job

    t = threading.Thread(target=_synthesize_job, args=(job_id, chunk_list, voice, speed), daemon=True)
    t.start()

    return jsonify({"job_id": job_id, "total_chunks": len(chunk_list)})


@app.route('/job/<job_id>/status', methods=['GET'])
def job_status(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
    if job is None:
        return jsonify({'error': 'Job not found'}), 404
    return jsonify({
        "ready": len(job["chunks"]),
        "total": job["total"],
        "done": job["done"],
        "error": job["error"],
    })


@app.route('/job/<job_id>/chunk/<int:index>', methods=['GET'])
def job_chunk(job_id, index):
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            return jsonify({'error': 'Job not found'}), 404
        if index >= len(job["chunks"]):
            return jsonify({'error': 'Chunk not yet ready'}), 404
        wav_bytes = job["chunks"][index]

    return send_file(io.BytesIO(wav_bytes), mimetype='audio/wav')


@app.route('/job/<job_id>', methods=['DELETE'])
def delete_job(job_id):
    with jobs_lock:
        jobs.pop(job_id, None)
    return '', 204


if __name__ == '__main__':
    print('Kokoro TTS running at http://localhost:5050')
    app.run(host='0.0.0.0', port=5050, debug=True)
