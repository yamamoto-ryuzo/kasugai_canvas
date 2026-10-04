"""KASUGAI Canvas ANTIGRAVITY エージェント API（Cloud Run 用 FastAPI サービス）

- POST /agent/chat  : 外部エージェントプロトコル {message,project,camera,layers,history} → {reply,actions,report}
- GET  /api/capabilities : フロントへの能力通知（tier=cloudrun）
- GET  /health     : 起動確認
- 認証モード（KASUGAI_AUTH_MODE。agent/AUTH_MODES.md 参照）:
  - 5 認証のみ: /api/auth・/api/kasc・/api/data がトークン検証（静的は公開）
  - 6 全ゲート : 5 + kasugai_session Cookie で全リクエストをゲート
  - 7 IAP    : x-goog-iap-jwt-assertion を検証（ゲートはインフラ側）
- /                : web/ の静的配信（同一オリジン運用・CORS 不要）
"""
import collections
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import agent, auth as authmod, config, storage as store_mod


def _static_root() -> Path:
    return Path(config.STATIC_DIR) if config.STATIC_DIR else Path(__file__).resolve().parents[2] / "web"


def _seed_kasc() -> None:
    """同梱 web/projects/*/*.kasc をストレージへ冪等シード（既存オブジェクトは上書きしない）"""
    if not config.SEED_KASC or not config.auth_mode():
        return
    projects = _static_root() / "projects"
    if not projects.is_dir():
        return
    store = store_mod.get_store()
    for path in sorted(projects.glob("*/*.kasc")):
        key = f"{store_mod.KASC_PREFIX}{path.parent.name}"
        if store.get(key) is None:
            store.put(key, path.read_bytes(), "text/plain; charset=utf-8")


@asynccontextmanager
async def _lifespan(app: FastAPI):
    _seed_kasc()
    yield


app = FastAPI(title="KASUGAI Canvas ANTIGRAVITY Agent", lifespan=_lifespan)

if config.ALLOW_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.ALLOW_ORIGINS,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )

# ---- モード6/7 のゲート（ミドルウェア）----

# ログイン描画に必要な静的ファイルのみ公開（workers/worker.js の PUBLIC_PATHS 相当）
_PUBLIC_PATHS = frozenset({
    "/", "/index.html", "/styles.css", "/favicon.ico",
    "/auth-selector.js", "/auth-login-form.js", "/auth-methods.json", "/i18n.js",
})
_PUBLIC_PREFIXES = ("/i18n/", "/PLUGIN/auth-")
# Cookie ゲートより先に自分で認証する API（worker.js と同じ処理順序）
_SELF_AUTH_PATHS = frozenset({"/api/auth", "/api/kasc", "/health"})
_SELF_AUTH_PREFIXES = ("/api/data/",)


@app.middleware("http")
async def auth_gate(request: Request, call_next):
    mode = config.AUTH_MODE
    if mode == "6":
        path = request.url.path
        public = path in _PUBLIC_PATHS or path.startswith(_PUBLIC_PREFIXES)
        self_auth = path in _SELF_AUTH_PATHS or path.startswith(_SELF_AUTH_PREFIXES)
        if not public and not self_auth and not authmod.request_authorized(request):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
    elif mode == "7":
        # IAP 直下では未認証リクエストは到達しない。ヘッダ必須で fail-closed にする
        if request.url.path != "/health" and not authmod.verify_iap(request):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
    return await call_next(request)


# IPあたり時間制限（公開エンドポイントの乱用防止。プロセス内の簡易実装で
# マルチインスタンス環境ではベストエフォート。本格運用は外部 HTTPS LB + Cloud Armor）
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
    mode = config.auth_mode()
    features = ["agent"] + (["auth", "kascWrite", "dataStore"] if mode else [])
    return {
        "tier": "cloudrun",
        "features": features,
        "auth": {"mode": {"5": "token", "6": "cookie", "7": "iap"}.get(mode)},
        "agent": {"endpoint": "/agent/chat"},
    }


# ---- 起動制御 API（モード5/6/7 共通。Cloudflare functions/api/ と同一契約）----

_PROJECT_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_MAX_KASC_BYTES = 1024 * 1024
_KEY_RE = re.compile(r"^[A-Za-z0-9_.\-/]+$")

_CONTENT_TYPES = {
    "geojson": "application/geo+json",
    "json": "application/json",
    "czml": "application/json",
    "kml": "application/vnd.google-earth.kml+xml",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "pmtiles": "application/octet-stream",
}


def _normalize_project_id(value) -> str:
    return re.sub(r"[^A-Z0-9]", "_", str(value).upper())


def _collect_kasc() -> dict:
    store = store_mod.get_store()
    kasc = {}
    for name in store.list(store_mod.KASC_PREFIX):
        data = store.get(name)
        if data is not None:
            kasc[_normalize_project_id(name[len(store_mod.KASC_PREFIX):])] = data.decode("utf-8", errors="replace")
    return kasc


def _data_key(path: str):
    if not path or not _KEY_RE.match(path) or ".." in path or path.startswith("/") or path.endswith("/"):
        return None
    return path


def _content_type(key: str) -> str:
    ext = key.rsplit(".", 1)[-1].lower() if "." in key else ""
    return _CONTENT_TYPES.get(ext, "application/octet-stream")


def _range_bounds(header: str):
    m = re.match(r"bytes=(\d+)-(\d*)$", header or "")
    if not m:
        return None
    return int(m.group(1)), (int(m.group(2)) if m.group(2) else None)


class AuthRequest(BaseModel):
    user: str = ""
    password: str = Field(default="", alias="pass")


class KascRequest(BaseModel):
    token: str = ""
    project: str = ""
    text: str = ""


@app.post("/api/auth")
async def api_auth(body: AuthRequest):
    if not config.AUTH_USER or not config.AUTH_PASS:
        return JSONResponse({"ok": False, "error": "Not configured"}, status_code=500)
    if body.user != config.AUTH_USER or body.password != config.AUTH_PASS:
        return JSONResponse({"ok": False, "error": "Unauthorized"}, status_code=401)
    token = authmod.create_token()
    response = JSONResponse(
        {"ok": True, "token": token, "kasc": _collect_kasc()},
        headers={"Cache-Control": "no-store"},
    )
    if config.AUTH_MODE == "6":
        response.set_cookie(
            authmod.COOKIE_NAME, token,
            max_age=authmod.COOKIE_MAX_AGE, httponly=True, secure=True, samesite="strict",
        )
    return response


@app.get("/api/auth")
async def api_auth_session(request: Request):
    """認可済みリクエストに kasugai トークンを発行する（モード7 IAP・モード6 Cookie 用）"""
    if not authmod.request_authorized(request):
        return JSONResponse({"ok": False, "error": "Unauthorized"}, status_code=401)
    return JSONResponse(
        {"ok": True, "token": authmod.create_token(), "kasc": _collect_kasc()},
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/kasc")
async def api_kasc(body: KascRequest, request: Request):
    # 本文の token または Cookie/IAP で認可
    if not (authmod.verify_token(body.token) or authmod.request_authorized(request)):
        return JSONResponse({"ok": False, "error": "Unauthorized"}, status_code=401)
    if not _PROJECT_RE.match(body.project):
        return JSONResponse({"ok": False, "error": "Invalid project"}, status_code=400)
    data = body.text.encode("utf-8")
    if len(data) > _MAX_KASC_BYTES:
        return JSONResponse({"ok": False, "error": "Invalid text"}, status_code=400)
    store_mod.get_store().put(
        f"{store_mod.KASC_PREFIX}{body.project}", data,
        "text/plain; charset=utf-8",
    )
    return {"ok": True}


@app.get("/api/data/{key:path}")
async def api_data_get(key: str, request: Request):
    if not authmod.request_authorized(request):
        return JSONResponse({"ok": False, "error": "Unauthorized"}, status_code=401)
    clean = _data_key(key)
    if not clean:
        return JSONResponse({"ok": False, "error": "Invalid path"}, status_code=400)
    store = store_mod.get_store()
    obj_key = f"{store_mod.DATA_PREFIX}{clean}"
    if config.DATA_REDIRECT:
        url = store.signed_url(obj_key, "GET", config.SIGNED_URL_TTL)
        if url:
            return RedirectResponse(url, status_code=302)
    bounds = _range_bounds(request.headers.get("range", ""))
    start = end = None
    if bounds:
        start, end = bounds
    data = store.get(obj_key, start, end)
    if data is None:
        return JSONResponse({"ok": False, "error": "Not Found"}, status_code=404)
    headers = {"Content-Type": _content_type(clean), "Cache-Control": "private, no-store"}
    status = 200
    if bounds:
        total = store.stat(obj_key)
        if total is not None:
            last = min(end if end is not None else total - 1, total - 1)
            headers["Content-Range"] = f"bytes {start}-{last}/{total}"
            headers["Accept-Ranges"] = "bytes"
            status = 206
    return Response(content=data, status_code=status, headers=headers)


@app.put("/api/data/{key:path}")
async def api_data_put(key: str, request: Request):
    if not authmod.request_authorized(request):
        return JSONResponse({"ok": False, "error": "Unauthorized"}, status_code=401)
    clean = _data_key(key)
    if not clean:
        return JSONResponse({"ok": False, "error": "Invalid path"}, status_code=400)
    body = await request.body()
    store_mod.get_store().put(
        f"{store_mod.DATA_PREFIX}{clean}", body,
        request.headers.get("content-type") or _content_type(clean),
    )
    return {"ok": True}


# KASUGAI_AUTH_MODE 設定時は control を動的に返す（モード変更にイメージ再ビルド不要）
if config.auth_mode():
    @app.get("/auth-methods.json")
    def auth_methods_json():
        return {"control": int(config.AUTH_MODE)}


# ---- エージェント ----

def _agent_authorized(request: Request) -> bool:
    if config.AUTH_MODE and authmod.request_authorized(request):
        return True
    if config.AGENT_TOKEN and request.headers.get("Authorization", "") == f"Bearer {config.AGENT_TOKEN}":
        return True
    # 認証モード時はいずれかの資格情報が必須。無認証モードは従来どおり
    return not config.AUTH_MODE and not config.AGENT_TOKEN


@app.post("/agent/chat")
async def agent_chat(body: ChatRequest, request: Request):
    if not body.message or not body.message.strip():
        return JSONResponse({"error": "message が空です"}, status_code=400)
    if len(body.message) > agent.MAX_MESSAGE_CHARS:
        return JSONResponse({"error": "message が長すぎます"}, status_code=400)

    if not _agent_authorized(request):
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
_static_dir = _static_root()
if _static_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(_static_dir), html=True), name="web")
