"""環境変数ベースの設定。Cloud Run では --set-env-vars / Secret Manager 経由で注入する"""
import os

# Gemini API キー（AI Studio 発行）。Cloud Run では Vertex AI（ADC）推奨
API_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
# "1"/"true" で Vertex AI 経由（Cloud Run のサービスアカウントで認証・キー管理不要）
USE_VERTEX = os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").lower() in ("1", "true", "yes")
GCP_PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
GCP_LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")

MODEL = os.environ.get("ANTIGRAVITY_MODEL", "gemini-2.5-flash")
# APIキーなしでの動作確認・フロント開発用モックモード
MOCK = os.environ.get("ANTIGRAVITY_MOCK", "").lower() in ("1", "true", "yes")
# 設定時は Authorization: Bearer <token> を必須化（公開エンドポイントの乱用防止）
AGENT_TOKEN = os.environ.get("ANTIGRAVITY_TOKEN", "")
# IPあたりの時間当たりリクエスト上限（0で無効）
RATE_LIMIT_PER_HOUR = int(os.environ.get("ANTIGRAVITY_RATE_LIMIT", "30"))
# 別オリジンからフロントを配信する場合の CORS 許可（カンマ区切り。同一オリジンなら不要）
ALLOW_ORIGINS = [o.strip() for o in os.environ.get("ALLOW_ORIGINS", "").split(",") if o.strip()]
# 静的配信する web/ の場所（省略時: リポジトリ直下の web/）
STATIC_DIR = os.environ.get("STATIC_DIR", "")

# ---- 起動制御（agent/AUTH_MODES.md 参照）----
# "5"=認証のみ / "6"=全ゲート / "7"=IAP。未設定・"0" は認証なし（control=0 相当）
AUTH_MODE = os.environ.get("KASUGAI_AUTH_MODE", "").strip()
# モード5/6 の ID/PASS（Secret Manager 推奨）
AUTH_USER = os.environ.get("KASUGAI_AUTH_USER", "")
AUTH_PASS = os.environ.get("KASUGAI_AUTH_PASS", "")
# トークン署名鍵（未設定時は AUTH_PASS を流用）
TOKEN_SECRET = os.environ.get("KASUGAI_TOKEN_SECRET", "") or AUTH_PASS
# .kasc / 秘匿データの格納バケット（未設定時は LOCAL_STORE / .datastore にフォールバック）
GCS_BUCKET = os.environ.get("KASUGAI_GCS_BUCKET", "")
# GCS 未設定時のローカル開発用ストレージディレクトリ
LOCAL_STORE = os.environ.get("KASUGAI_LOCAL_STORE", "")
# GET /api/data を GCS 署名付き URL へ 302 するか（0 でプロキシ配信）
DATA_REDIRECT = os.environ.get("KASUGAI_DATA_REDIRECT", "1").lower() not in ("0", "false", "no")
SIGNED_URL_TTL = int(os.environ.get("KASUGAI_SIGNED_URL_TTL", "900"))
# モード7: IAP JWT の audience（/projects/<番号>/apps/<プロジェクトID>）。
# 設定時は署名検証、未設定でも IAP 直下では到達自体が認証済みとみなす
IAP_AUDIENCE = os.environ.get("KASUGAI_IAP_AUDIENCE", "")
# 起動時に web/projects/*/*.kasc をストレージへ冪等シードするか（0 で無効）
SEED_KASC = os.environ.get("KASUGAI_SEED_KASC", "1").lower() not in ("0", "false", "no")


def auth_mode() -> str:
    """有効な認証モード（"5"|"6"|"7"）。認証なしは空文字"""
    return AUTH_MODE if AUTH_MODE in ("5", "6", "7") else ""


def configured() -> bool:
    """実際の Gemini 呼び出しが可能か"""
    return MOCK or USE_VERTEX or bool(API_KEY)
