import pytest
from app import app


@pytest.fixture
def client():
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client


def test_speak_valid_text_returns_wav(client):
    response = client.post('/speak', json={'text': 'Hello world'})
    assert response.status_code == 200
    assert response.content_type == 'audio/wav'


def test_speak_missing_text_returns_400(client):
    response = client.post('/speak', json={})
    assert response.status_code == 400


def test_speak_empty_text_returns_400(client):
    response = client.post('/speak', json={'text': '   '})
    assert response.status_code == 400


def test_voices_returns_list_with_at_least_10(client):
    response = client.get('/voices')
    assert response.status_code == 200
    data = response.get_json()
    assert isinstance(data, list)
    assert len(data) >= 10


def test_speak_custom_voice_and_speed_returns_200(client):
    response = client.post('/speak', json={
        'text': 'Testing custom voice',
        'voice': 'am_adam',
        'speed': 1.5
    })
    assert response.status_code == 200
    assert response.content_type == 'audio/wav'


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


def test_speak_text_over_5000_chars_returns_400(client):
    long_text = 'a' * 5001
    response = client.post('/speak', json={'text': long_text})
    assert response.status_code == 400


def test_speak_text_over_5000_chars_returns_error_key(client):
    long_text = 'a' * 5001
    response = client.post('/speak', json={'text': long_text})
    data = response.get_json()
    assert 'error' in data


def test_index_contains_char_counter(client):
    response = client.get('/')
    assert b'5000' in response.data
