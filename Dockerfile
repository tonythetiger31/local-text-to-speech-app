FROM python:3.12-slim

WORKDIR /app

# Install system deps for soundfile (libsndfile) and espeak-ng (kokoro phonemizer)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    espeak-ng \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps in a separate layer so they're cached between rebuilds.
# torch is ~800MB — this layer only re-runs when requirements.txt changes.
COPY requirements.txt .
RUN pip install -r requirements.txt

# Pre-download Kokoro model weights into the image so first run is instant.
RUN python - <<'EOF'
from kokoro import KPipeline
KPipeline(lang_code='a')
EOF

COPY . .

EXPOSE 5050

CMD ["python", "app.py"]
