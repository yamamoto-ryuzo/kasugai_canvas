"""サーバーサイドツール。Gemini の function calling から呼ばれる。

- fetch_url: CORS に縛られないサーバーサイド取得（SSRF 緩和のため private/loopback を拒否）
- generate_sample_geojson: ネストした Gemini 呼び出しで架空サンプル GeoJSON を生成・検証・出典付与
"""
import datetime
import ipaddress
import json
import re
import socket
import urllib.parse

import httpx

from . import config

MAX_FETCH_BYTES = 200 * 1024
FETCH_TIMEOUT = 15.0
MAX_SAMPLE_FEATURES = 200

# private/loopback/リンクローカル宛ての fetch を拒否（Cloud Run 上のオープンプロキシ化防止）
_BLOCKED_HOST_RE = re.compile(r"^(localhost|.*\.(internal|local|localhost))$", re.I)


def _is_blocked_host(hostname: str) -> bool:
    host = (hostname or "").strip().lower()
    if not host or _BLOCKED_HOST_RE.match(host):
        return True
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast
    except ValueError:
        pass
    try:
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return True
    except (socket.gaierror, ValueError):
        return True
    return False


async def fetch_url(url: str) -> dict:
    if not re.match(r"^https?://", url or ""):
        return {"ok": False, "error": "http/https URL のみ指定できます"}
    if _is_blocked_host(urllib.parse.urlparse(url).hostname or ""):
        return {"ok": False, "error": "内部・プライベートアドレス宛ての取得はできません"}
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=FETCH_TIMEOUT) as client:
            response = await client.get(url, headers={"User-Agent": "kasugai-canvas-antigravity/1.0"})
        content = response.content[:MAX_FETCH_BYTES]
        text = content.decode("utf-8", errors="replace")
        return {
            "ok": response.is_success,
            "status": response.status_code,
            "contentType": response.headers.get("content-type", ""),
            "truncated": len(response.content) > MAX_FETCH_BYTES,
            "text": text,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _extract_json(text: str):
    """モデル出力からJSONを取り出す（コードフェンス・前後の文章を許容）"""
    text = (text or "").strip()
    match = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if match:
        text = match.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def _stamp_provenance(feature: dict) -> dict:
    props = feature.get("properties")
    if not isinstance(props, dict):
        props = {}
    props.setdefault("出典", "ANTIGRAVITY 自動生成サンプル")
    props["generatedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    props["sourceNote"] = "AIが生成した架空サンプルデータ（本番データではありません）"
    feature["properties"] = props
    return feature


async def generate_sample_geojson(client, args: dict) -> dict:
    theme = str(args.get("theme") or "")
    area = str(args.get("area") or "")
    count = max(1, min(int(args.get("count") or 20), MAX_SAMPLE_FEATURES))
    geometry = str(args.get("geometry") or "Point")
    attributes = str(args.get("attributes") or "")
    lat = args.get("latitude")
    lon = args.get("longitude")
    radius = args.get("radius_km")

    center_hint = ""
    if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
        r = radius if isinstance(radius, (int, float)) else 5
        center_hint = f"中心は緯度{lat}・経度{lon}、半径約{r}km以内に地物を配置すること。"

    prompt = f"""GIS 体験用の架空サンプルデータを GeoJSON FeatureCollection として生成してください。

テーマ: {theme}
エリア: {area}
地物数: {count}
ジオメトリ種別: {geometry}
属性（各featureのpropertiesに含める項目）: {attributes}
{center_hint}

要件:
- 出力は GeoJSON の FeatureCollection JSON のみ（前後の説明・コードフェンス不要）
- coordinates は [経度, 緯度] の順（EPSG:4326）
- 現実にありそうな名称・属性値・分布にする（実在しない架空データでよい）
- 各地物の properties には名称（name）を必ず含める
"""
    last_error = None
    for _ in range(2):
        try:
            resp = await client.aio.models.generate_content(model=config.MODEL, contents=prompt)
            fc = _extract_json(resp.text or "")
            if not isinstance(fc, dict) or fc.get("type") != "FeatureCollection" or not isinstance(fc.get("features"), list):
                last_error = "GeoJSON FeatureCollection として解析できませんでした"
                continue
            features = []
            for f in fc["features"][:MAX_SAMPLE_FEATURES]:
                if isinstance(f, dict) and isinstance(f.get("geometry"), dict) and f["geometry"].get("coordinates") is not None:
                    f.setdefault("type", "Feature")
                    features.append(_stamp_provenance(f))
            if not features:
                last_error = "有効な地物がありませんでした"
                continue
            return {"ok": True, "featureCount": len(features), "geojson": {"type": "FeatureCollection", "features": features}}
        except Exception as e:
            last_error = str(e)
    return {"ok": False, "error": last_error or "サンプル生成に失敗しました"}


async def run_server_tool(client, name: str, args: dict) -> dict:
    try:
        if name == "fetch_url":
            return await fetch_url(str(args.get("url") or ""))
        if name == "generate_sample_geojson":
            return await generate_sample_geojson(client, args)
        return {"ok": False, "error": f"unknown tool: {name}"}
    except Exception as e:
        return {"ok": False, "error": f"{name}: {e}"}
