"""KASUGAI Canvas ANTIGRAVITY エージェント API（Cloud Run 用 FastAPI サービス）

- POST /agent/chat  : 外部エージェントプロトコル {message,project,camera,layers,history} → {reply,actions,report}
- GET  /api/capabilities : フロントへの能力通知（tier=cloudrun）
- GET  /health     : 起動確認
- /                : web/ の静的配信（同一オリジン運用・CORS 不要）
"""
import collections
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import agent, config

app = FastAPI(title="KASUGAI Canvas ANTIGRAVITY Agent")

if config.ALLOW_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.ALLOW_ORIGINS,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )

# IPあたり時間制限（公開エンドポイントの乱用防止。プロセス内の簡易実装）
_requests: dict[str, collections.deque] = collections.defaultdict(collections.deque)


def _rate_limited(ip: str) -> bool:
    limit = config.RATE_LIMIT_PER_HOUR
    if limit <= 0:
        return False
    now = time.time()
    queue = _requests[ip]
    while queue and queue[0] < now - 3600:
        queue.popleft()
    if len(queue) >= limit:
        return True
    queue.append(now)
    return False


class ChatRequest(BaseModel):
    message: str
    project: str | None = None
    camera: dict | None = None
    layers: list | None = None
    history: list | None = None


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/capabilities")
def capabilities():
    return {
        "tier": "cloudrun",
        "features": ["agent"],
        "agent": {"endpoint": "/agent/chat"},
    }


@app.post("/agent/chat")
async def agent_chat(body: ChatRequest, request: Request):
    if not body.message or not body.message.strip():
        return JSONResponse({"error": "message が空です"}, status_code=400)
    if len(body.message) > agent.MAX_MESSAGE_CHARS:
        return JSONResponse({"error": "message が長すぎます"}, status_code=400)

    if config.AGENT_TOKEN:
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {config.AGENT_TOKEN}":
            return JSONResponse({"error": "Unauthorized"}, status_code=401)

    client_ip = request.client.host if request.client else "unknown"
    if _rate_limited(client_ip):
        return JSONResponse({"error": "rate limit exceeded"}, status_code=429)

    if config.MOCK:
        return agent.mock_response(body.message)

    if not config.configured():
        return JSONResponse(
            {"error": "AGENT_NOT_CONFIGURED", "detail": "GEMINI_API_KEY または Vertex AI (GOOGLE_GENAI_USE_VERTEXAI=1) を設定してください"},
            status_code=503,
        )

    try:
        return await agent.run_agent(body.message, body.project, body.camera, body.layers, body.history)
    except Exception as e:
        return JSONResponse({"error": f"agent error: {e}"}, status_code=502)


# 静的配信は API ルートの後にマウント（同一オリジンでフロント＋エージェントを提供）
_static_dir = Path(config.STATIC_DIR) if config.STATIC_DIR else Path(__file__).resolve().parents[2] / "web"
if _static_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(_static_dir), html=True), name="web")
