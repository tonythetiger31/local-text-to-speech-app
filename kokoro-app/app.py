import io
import numpy as np
import soundfile as sf
from flask import Flask, request, jsonify, send_file
from kokoro import KPipeline

app = Flask(__name__)

pipeline = KPipeline(lang_code='a')

VOICES = [
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica",
    "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis"
]


@app.route('/')
def index():
    return "Frontend coming soon"


@app.route('/voices')
def voices():
    return jsonify(VOICES)


@app.route('/speak', methods=['POST'])
def speak():
    data = request.get_json(silent=True) or {}

    text = data.get('text', '').strip()
    if not text:
        return jsonify({'error': 'text is required and must be non-empty'}), 400

    voice = data.get('voice', 'af_bella')
    speed = float(data.get('speed', 1.0))

    chunks = []
    for _, _, audio in pipeline(text, voice=voice, speed=speed):
        if audio is not None:
            chunks.append(audio)

    if chunks:
        audio_data = np.concatenate(chunks)
    else:
        audio_data = np.array([], dtype=np.float32)

    buffer = io.BytesIO()
    sf.write(buffer, audio_data, 24000, format='WAV')
    buffer.seek(0)

    return send_file(buffer, mimetype='audio/wav')


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5050, debug=True)
