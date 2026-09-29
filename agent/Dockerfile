# ビルドコンテキストはリポジトリ直下（web/ を同梱するため）
#   docker build -f agent/Dockerfile -t kasugai-canvas .
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1
WORKDIR /app

COPY agent/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY agent /app/agent
COPY web /app/web

ENV STATIC_DIR=/app/web \
    PORT=8080
EXPOSE 8080

CMD ["uvicorn", "agent.app.main:app", "--host", "0.0.0.0", "--port", "8080"]
