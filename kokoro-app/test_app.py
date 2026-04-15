import time
import pytest
from app import app, split_into_chunks, voice_id_to_name


@pytest.fixture
def client():
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client


# --- /speak ---

def test_speak_valid_text_returns_job(client):
    response = client.post('/speak', json={'text': 'Hello world.'})
    assert response.status_code == 200
    data = response.get_json()
    assert 'job_id' in data
    assert 'total_chunks' in data


def test_speak_missing_text_returns_400(client):
    response = client.post('/speak', json={})
    assert response.status_code == 400


def test_speak_empty_text_returns_400(client):
    response = client.post('/speak', json={'text': '   '})
    assert response.status_code == 400


def test_speak_text_over_100000_chars_returns_400(client):
    long_text = 'a' * 100001
    response = client.post('/speak', json={'text': long_text})
    assert response.status_code == 400


def test_speak_text_over_100000_chars_returns_error_key(client):
    long_text = 'a' * 100001
    response = client.post('/speak', json={'text': long_text})
    data = response.get_json()
    assert 'error' in data
    assert '100000' in data['error']


# --- /job/<id>/status ---

def test_job_status_returns_correct_total(client):
    multi = 'Hello world. This is sentence two. And here is sentence three.'
    response = client.post('/speak', json={'text': multi})
    job_id = response.get_json()['job_id']
    total_chunks = response.get_json()['total_chunks']

    status = client.get(f'/job/{job_id}/status').get_json()
    assert status['total'] == total_chunks
    assert 'done' in status
    assert 'ready' in status


def test_job_status_unknown_id_returns_404(client):
    response = client.get('/job/nonexistent-id/status')
    assert response.status_code == 404


# --- /job/<id>/chunk/<index> ---

def test_job_chunk_0_eventually_returns_wav(client):
    response = client.post('/speak', json={
        'text': 'Hello world. Testing chunked synthesis.',
        'voice': 'af_bella',
        'speed': 1.0,
    })
    assert response.status_code == 200
    job_id = response.get_json()['job_id']

    # Poll until done
    for _ in range(60):
        status = client.get(f'/job/{job_id}/status').get_json()
        if status['done']:
            break
        time.sleep(1)

    chunk_resp = client.get(f'/job/{job_id}/chunk/0')
    assert chunk_resp.status_code == 200
    assert chunk_resp.content_type == 'audio/wav'


# --- split_into_chunks ---

def test_split_into_chunks_multi_sentence():
    text = 'Hello world. This is sentence two. And here is sentence three.'
    chunks = split_into_chunks(text)
    assert len(chunks) >= 2


def test_split_into_chunks_returns_nonempty_strings():
    text = 'First sentence. Second sentence! Third one?'
    chunks = split_into_chunks(text)
    assert all(c.strip() for c in chunks)


# --- unchanged /voices ---

def test_voices_returns_list_with_at_least_10(client):
    response = client.get('/voices')
    assert response.status_code == 200
    data = response.get_json()
    assert isinstance(data, list)
    assert len(data) >= 10


# --- / index ---

def test_index_returns_200(client):
    response = client.get('/')
    assert response.status_code == 200


def test_index_contains_title(client):
    response = client.get('/')
    assert b'Kokoro TTS' in response.data


def test_index_contains_textarea(client):
    response = client.get('/')
    assert b'<textarea' in response.data


def test_index_contains_select(client):
    response = client.get('/')
    assert b'<select' in response.data


def test_index_contains_20000_char_limit(client):
    response = client.get('/')
    assert b'20000' in response.data


def test_index_contains_generating_progress(client):
    response = client.get('/')
    assert b'Generating' in response.data


def test_index_contains_playing_progress(client):
    response = client.get('/')
    assert b'Playing' in response.data


def test_index_contains_key_element_ids(client):
    response = client.get('/')
    assert b'id="speak-btn"' in response.data
    assert b'id="readalong"' in response.data
    assert b'id="progress-section"' in response.data
    assert b'id="expand-btn"' in response.data


def test_index_contains_glassmorphism_css(client):
    response = client.get('/')
    assert b'backdrop-filter' in response.data


# --- voice_id_to_name ---

def test_voice_id_to_name_af_alloy():
    assert voice_id_to_name('af_alloy') == 'American Female Alloy'


def test_voice_id_to_name_bm_george():
    assert voice_id_to_name('bm_george') == 'British Male George'


# --- /preview ---

def test_preview_valid_voice_returns_wav(client):
    response = client.post('/preview', json={'voice': 'af_bella'})
    assert response.status_code == 200
    assert response.content_type == 'audio/wav'


def test_preview_missing_voice_returns_400(client):
    response = client.post('/preview', json={})
    assert response.status_code == 400


def test_preview_unknown_voice_returns_400(client):
    response = client.post('/preview', json={'voice': 'xx_unknown'})
    assert response.status_code == 400
