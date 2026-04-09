FROM python:3.12-slim

WORKDIR /app

# Install system deps for soundfile (libsndfile) and espeak-ng (kokoro phonemizer)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    espeak-ng \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5050

CMD ["python", "app.py"]
