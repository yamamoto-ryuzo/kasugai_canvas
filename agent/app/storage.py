""".kasc と秘匿データのストレージ。

本番は GCS バケット（KASUGAI_GCS_BUCKET）、未設定時はローカルディレクトリ
（KASUGAI_LOCAL_STORE またはリポジトリ直下 .datastore/）にフォールバックする。
キーは kasc/<projectId> と data/<key> のプレフィックスで分ける。
"""
import datetime
from pathlib import Path

from . import config

KASC_PREFIX = "kasc/"
DATA_PREFIX = "data/"

_store = None


class LocalStore:
    """開発用のローカルファイルストア"""

    def __init__(self, root: str):
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        return self.root / key

    def get(self, key: str, start=None, end=None):
        path = self._path(key)
        if not path.is_file():
            return None
        data = path.read_bytes()
        if start is not None:
            data = data[start:(end + 1) if end is not None else None]
        return data

    def stat(self, key: str):
        path = self._path(key)
        return path.stat().st_size if path.is_file() else None

    def put(self, key: str, data: bytes, content_type: str = ""):
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def list(self, prefix: str):
        base = self._path(prefix)
        if not base.is_dir():
            return []
        return [
            str(p.relative_to(self.root)).replace("\\", "/")
            for p in base.rglob("*") if p.is_file()
        ]

    def signed_url(self, key: str, method: str, ttl: int):
        return None


class GcsStore:
    """GCS バケットストア（google-cloud-storage は遅延ロード）"""

    def __init__(self, bucket_name: str):
        from google.cloud import storage as gcs
        self._client = gcs.Client()
        self._bucket = self._client.bucket(bucket_name)

    def get(self, key: str, start=None, end=None):
        blob = self._bucket.blob(key)
        if not blob.exists():
            return None
        try:
            return blob.download_as_bytes(start=start, end=end)
        except TypeError:
            # 古いライブラリは start/end 未対応
            data = blob.download_as_bytes()
            if start is not None:
                data = data[start:(end + 1) if end is not None else None]
            return data

    def stat(self, key: str):
        blob = self._bucket.blob(key)
        try:
            blob.reload()
            return blob.size
        except Exception:
            return None

    def put(self, key: str, data: bytes, content_type: str = ""):
        self._bucket.blob(key).upload_from_string(data, content_type=content_type or None)

    def list(self, prefix: str):
        return [b.name for b in self._client.list_blobs(self._bucket, prefix=prefix)]

    def signed_url(self, key: str, method: str, ttl: int):
        """V4 署名付き URL。Cloud Run では実行 SA の signBlob（iamcredentials）を使う。
        権限不足・ローカル認証などで失敗した場合は None（呼び出し側でプロキシに逃げる）"""
        try:
            import google.auth
            from google.auth.transport import requests as google_requests
            creds, _ = google.auth.default()
            request = google_requests.Request()
            creds.refresh(request)
            kwargs = {}
            sa_email = getattr(creds, "service_account_email", "")
            if sa_email:
                kwargs = {"service_account_email": sa_email, "access_token": creds.token}
            blob = self._bucket.blob(key)
            return blob.generate_signed_url(
                version="v4",
                expiration=datetime.timedelta(seconds=ttl),
                method=method,
                **kwargs,
            )
        except Exception:
            return None


def get_store():
    global _store
    if _store is None:
        if config.GCS_BUCKET:
            _store = GcsStore(config.GCS_BUCKET)
        else:
            root = config.LOCAL_STORE or str(Path(__file__).resolve().parents[2] / ".datastore")
            _store = LocalStore(root)
    return _store
