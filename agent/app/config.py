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


def configured() -> bool:
    """実際の Gemini 呼び出しが可能か"""
    return MOCK or USE_VERTEX or bool(API_KEY)
