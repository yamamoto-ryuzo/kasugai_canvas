"""認証トークンと各モードの認可判定。

トークン形式は functions/_lib/token.js と同一の `expiry.HMAC-SHA256(expiry)`。
秘密鍵が同じなら Cloudflare 側と相互検証できる。
"""
import hashlib
import hmac
import time

from . import config

TOKEN_TTL_MS = 12 * 60 * 60 * 1000
COOKIE_NAME = "kasugai_session"
COOKIE_MAX_AGE = 12 * 60 * 60

IAP_JWT_HEADER = "x-goog-iap-jwt-assertion"
_IAP_CERTS_URL = "https://www.gstatic.com/iap/verify/public_key"


def create_token(ttl_ms: int = TOKEN_TTL_MS) -> str:
    expiry = str(int(time.time() * 1000) + ttl_ms)
    sig = hmac.new(config.TOKEN_SECRET.encode(), expiry.encode(), hashlib.sha256).hexdigest()
    return f"{expiry}.{sig}"


def verify_token(token) -> bool:
    if not isinstance(token, str) or not config.TOKEN_SECRET:
        return False
    dot = token.find(".")
    if dot < 0:
        return False
    expiry, sig = token[:dot], token[dot + 1:]
    if not expiry.isdigit() or int(expiry) < int(time.time() * 1000):
        return False
    expected = hmac.new(config.TOKEN_SECRET.encode(), expiry.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)


def request_token(request) -> str:
    """?token= / Authorization: Bearer / kasugai_session Cookie の順で取り出す"""
    token = request.query_params.get("token")
    if token:
        return token
    header = request.headers.get("authorization", "")
    if header.startswith("Bearer "):
        return header[7:]
    return request.cookies.get(COOKIE_NAME, "")


def verify_iap(request) -> bool:
    """IAP JWT の検証。KASUGAI_IAP_AUDIENCE 設定時は署名も検証する。
    未設定でも IAP 直下ではリクエスト到達自体が IAP 認証済みを意味するため、
    ヘッダの存在のみを確認する"""
    jwt = request.headers.get(IAP_JWT_HEADER, "")
    if not jwt:
        return False
    if not config.IAP_AUDIENCE:
        return True
    try:
        from google.auth.transport import requests as google_requests
        from google.oauth2 import id_token as google_id_token
        info = google_id_token.verify_token(
            jwt, google_requests.Request(),
            audience=config.IAP_AUDIENCE, certs_url=_IAP_CERTS_URL,
        )
        return bool(info)
    except Exception:
        return False


def request_authorized(request) -> bool:
    """kasugai トークン（Cookie/Bearer/クエリ）またはモード7の IAP JWT で認可済みか"""
    if verify_token(request_token(request)):
        return True
    if config.AUTH_MODE == "7" and verify_iap(request):
        return True
    return False
