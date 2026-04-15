# Kokoro TTS

A local text-to-speech web app powered by [Kokoro](https://github.com/hexgrad/kokoro). Paste text, pick a voice, adjust speed, and generate audio — all running on your machine with no external API calls.

![Kokoro TTS screenshot](screenshot.png)

## Prerequisites

> **Docker is required.** The run command below will not work without it.

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/) (included with Docker Desktop)

No local Python setup required. `espeak-ng` and all Python dependencies are installed inside the container.

## Run

```bash
docker compose up --build
```

Then open **http://localhost:5050** in your browser.

## Features

- 28 voices (American and British English, male and female)
- Adjustable speed (0.5×–2.0×)
- Up to 100,000 characters per request
- Returns audio as WAV, playable directly in the browser

## API

`POST /speak` — accepts JSON `{ "text": "...", "voice": "af_bella", "speed": 1.0 }`, returns `audio/wav`.

`GET /voices` — returns the list of available voice IDs as JSON.
