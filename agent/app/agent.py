"""ANTIGRAVITY エージェントの中核ロジック。

既存の外部エージェントプロトコル（POST /agent/chat → {reply, actions, report}）を
Gemini API（google-genai）で実装する。

2段構成:
1. function calling ループでサーバーツール（fetch_url / generate_sample_geojson）を回す
2. response_schema による構造化出力で {reply, actions, report} を組み立てる
   （actions の args は argsJson 文字列で受け、サーバー側でパース・検証する）
"""
import json
import re

from google import genai
from google.genai import types

from . import config
from . import tools as server_tools

MAX_TOOL_STEPS = 8
MAX_ACTIONS = 30
MAX_HISTORY = 20
MAX_MESSAGE_CHARS = 4000

_client = None


def get_client():
    global _client
    if _client is None:
        if config.USE_VERTEX:
            _client = genai.Client(vertexai=True, project=config.GCP_PROJECT, location=config.GCP_LOCATION)
        else:
            _client = genai.Client(api_key=config.API_KEY)
    return _client


# 公開環境のエージェントが返してよいフロント側アクション。
# プラグイン書き込み・ファイル削除・アプリ終了など高権限・破壊的な操作は除外する
ALLOWED_ACTIONS = {
    "flyTo", "flyToFeature", "setLayerVisible", "listLayers", "focusLayer",
    "getCamera", "listBasemaps", "setBasemap", "searchLocation",
    "applyCameraPreset", "listCameraPresets", "setTerrain", "setEffect",
    "setUnderground", "setClip", "listFlyPaths", "playFlyPath", "stopFly",
    "vectorSearch", "getShareUrl", "buildShareUrl", "listProjects", "listDataFiles",
    "toggleDrawMode", "applyInspector", "exportInspector", "runCode",
    "addLayer", "addGeoJsonLayer", "addDataLayer", "removeDataLayer",
    "fetchData", "getLayerGeoJson", "searchPlaces", "openStreetView", "showReport",
}

ACTION_SPECS = """
- flyTo {latitude, longitude, height?, pitch?, heading?} : カメラ移動（height/pitch省略でドローン視点）
- flyToFeature {latitude, longitude, height?, pitch?, heading?} : 地物・地点を見せるときはこちら
- setLayerVisible {name, visible} / listLayers {} / focusLayer {name}
- getCamera {} / listBasemaps {} / setBasemap {name}
- searchLocation {query, provider?} / searchPlaces {query} / openStreetView {latitude, longitude}
- applyCameraPreset {name} / listCameraPresets {}
- setTerrain {enabled} / setEffect {name, enabled}（name: lighting|translucency|fog|atmosphere|shadows|depthTest）
- setUnderground {transparency?, dive?} / setClip {type: ns|ew|h|clear}
- listFlyPaths {} / playFlyPath {name} / stopFly {}
- vectorSearch {query} : 読み込み済みベクターの属性検索
- getShareUrl {} / buildShareUrl {latitude, longitude, height?, pitch?, heading?, project?} : 共有URL（後者は任意視点）
- listProjects {} / listDataFiles {}
- toggleDrawMode {}
- applyInspector {text} : .kasc 設定全体を上書き（ユーザー明示時のみ）
- exportInspector {}
- runCode {code} : ブラウザ内サンドボックスJS（api.<ツール名>で地図操作可・DOM/fetch不可）
- addLayer {title, target, type?, options?} : type= geojson|layer|geoparquet|flatgeobuf|gpkg|duckdb|sql、target はURLかSELECT文。.kascに行追記される
- addGeoJsonLayer {title, url}
- addDataLayer {title, geojson} : GeoJSONオブジェクトを一時レイヤーとして直接表示（.kascには含まれない）
- removeDataLayer {name}
- fetchData {url} / getLayerGeoJson {name}
- showReport {title, format:"markdown"|"html", content} : 資料をモーダル表示・ダウンロードさせる
"""

SYSTEM_INSTRUCTION = f"""あなたは KASUGAI Canvas の ANTIGRAVITY エージェントです。
KASUGAI Canvas は CesiumJS ベースの3D GIS ビューアで、レイヤー表示・FlyTo・ベクトル検索・属性/凡例パネル・.kasc 設定・共有URL などの機能を持ちます。

あなたの使命は「GIS で何ができて、どんな課題が解決できるか」を利用者に本番導入前に体験してもらうことです。
資料作成の基本プロセス「作る → 見せる → 説明する」に従って自律的に行動してください。

- 作る: 目的に応じたレイヤー構成・属性・カメラ位置を自動決定し、actions でレイヤー追加・表示を行う
- 見せる: 本番データがなくても generate_sample_geojson で現実に近い架空サンプルを生成し、addDataLayer で表示・FlyTo で案内する
- 説明する: レイヤー属性から課題を抽出し、「平面（地図上の状況）・内容・解決案」構成の資料を report として作成する

【使えるサーバーツール】（このターン内で自律的に呼び出せる）
- fetch_url(url): 外部URLからテキスト/JSON/CSVを取得（最大200KB・内部アドレス不可）
- generate_sample_geojson(theme, area, count, geometry, attributes, latitude?, longitude?, radius_km?): 架空サンプルの GeoJSON FeatureCollection を生成して返す

【クライアント actions】（応答の actions に {{"name":..., "argsJson":"{{...}}"}} として列挙するとブラウザが順次実行する。argsJson は JSON オブジェクトを文字列化したもの）
{ACTION_SPECS}

【ルール】
- レイヤーを追加したら、全体が見える位置への flyTo または focusLayer を同じ応答の actions に含める
- サンプルデータは必ず「AIが生成した架空サンプル」である旨を reply と資料に明記する
- 資料を求められたら report に {{title, format:"markdown", content}} を入れる。内容は「平面（どこに何があるか）・内容（読み取れる課題）・解決案」構成とし、各節にその節の視点を開くパーマリンクを `[視点](?longitude=...&latitude=...&height=...&pitch=...&heading=...)` 形式の相対URLで埋め込む
- 取得・生成したデータの出典・ライセンス・取得時刻は reply または資料に明記する（可観測性）
- 破壊的操作（プラグイン保存/削除・ファイル削除・アプリ終了・プロジェクト切替）は行わない
- 回答はユーザーの言語（通常は日本語）で簡潔に
"""

RESPONSE_SCHEMA = types.Schema(
    type="OBJECT",
    properties={
        "reply": types.Schema(type="STRING", description="ユーザーへの回答文"),
        "actions": types.Schema(
            type="ARRAY",
            description="ブラウザで順次実行するアクション一覧",
            items=types.Schema(
                type="OBJECT",
                properties={
                    "name": types.Schema(type="STRING", description="アクション名"),
                    "argsJson": types.Schema(type="STRING", description="引数のJSONオブジェクト文字列。例: \"{\\\"latitude\\\":35.1}\". 引数不要なら \"{}\""),
                },
                required=["name", "argsJson"],
            ),
        ),
        "report": types.Schema(
            type="OBJECT",
            description="資料が求められた場合のみ",
            properties={
                "title": types.Schema(type="STRING"),
                "format": types.Schema(type="STRING", description="markdown または html"),
                "content": types.Schema(type="STRING", description="資料本文。各節に視点パーマリンクを含める"),
            },
            required=["title", "content"],
        ),
    },
    required=["reply"],
)

SERVER_TOOL = types.Tool(function_declarations=[
    types.FunctionDeclaration(
        name="fetch_url",
        description="外部URLからテキスト/JSON/CSVを取得する（最大200KB・内部アドレス不可）。公開統計やGeoJSONの確認に使う",
        parameters=types.Schema(
            type="OBJECT",
            properties={"url": types.Schema(type="STRING", description="取得するURL(http/https)")},
            required=["url"],
        ),
    ),
    types.FunctionDeclaration(
        name="generate_sample_geojson",
        description="エリア・テーマに応じた架空サンプルの GeoJSON FeatureCollection を生成する。本番データがない場合の GIS 体験用レイヤーに使う",
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "theme": types.Schema(type="STRING", description="テーマ（例: 避難所・駐車場・店舗）"),
                "area": types.Schema(type="STRING", description="対象エリア（例: 春日井市）"),
                "count": types.Schema(type="INTEGER", description="地物数（最大200・省略時20）"),
                "geometry": types.Schema(type="STRING", description="Point/LineString/Polygon（省略時Point）"),
                "attributes": types.Schema(type="STRING", description="各featureのpropertiesに含める属性項目（カンマ区切り）"),
                "latitude": types.Schema(type="NUMBER", description="配置中心の緯度（省略可）"),
                "longitude": types.Schema(type="NUMBER", description="配置中心の経度（省略可）"),
                "radius_km": types.Schema(type="NUMBER", description="配置半径km（省略時5）"),
            },
            required=["theme", "area"],
        ),
    ),
])

FINAL_INSTRUCTION = """これまでの内容を踏まえ、最終応答をJSONで出力してください。
- reply: ユーザーへの回答文（実行した操作・データの出典・残課題を簡潔に）
- actions: 地図へ反映する操作 [{name, argsJson}]（なければ []）
- report: 資料が求められた場合のみ {title, format, content}"""


def _merge_role(role: str) -> str:
    return "user" if role in ("user", "system") else "model"


def _build_contents(message: str, project, camera, layers, history) -> list:
    contents = []
    for entry in (history or [])[-MAX_HISTORY:]:
        if not isinstance(entry, dict) or not isinstance(entry.get("text"), str) or not entry["text"].strip():
            continue
        role = _merge_role(str(entry.get("role") or "user"))
        text = entry["text"][:2000]
        if entry.get("role") == "system":
            text = f"[log] {text}"
        if contents and contents[-1].role == role:
            contents[-1].parts.append(types.Part(text=text))
        else:
            contents.append(types.Content(role=role, parts=[types.Part(text=text)]))

    layer_brief = []
    for item in (layers or [])[:50]:
        if isinstance(item, dict):
            layer_brief.append({k: item.get(k) for k in ("id", "title", "name", "type", "visible", "group") if item.get(k) is not None})
        else:
            layer_brief.append(item)
    layers_json = json.dumps(layer_brief, ensure_ascii=False)[:4000]

    context = (
        "[現在の状態]\n"
        f"project: {project or 'default'}\n"
        f"camera: {json.dumps(camera or {}, ensure_ascii=False)}\n"
        f"layers: {layers_json}\n"
        "[ユーザーの指示]\n"
        f"{message[:MAX_MESSAGE_CHARS]}"
    )
    if contents and contents[-1].role == "user":
        contents[-1].parts.append(types.Part(text=context))
    else:
        contents.append(types.Content(role="user", parts=[types.Part(text=context)]))
    return contents


def _sanitize_actions(raw_actions) -> list:
    actions = []
    for item in (raw_actions or [])[:MAX_ACTIONS]:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "")
        if name not in ALLOWED_ACTIONS:
            continue
        args = item.get("args")
        if args is None:
            raw = item.get("argsJson")
            try:
                args = json.loads(raw) if isinstance(raw, str) and raw.strip() else {}
            except json.JSONDecodeError:
                continue
        actions.append({"name": name, "args": args if isinstance(args, dict) else {}})
    return actions


def _sanitize_report(raw_report):
    if not isinstance(raw_report, dict):
        return None
    title = str(raw_report.get("title") or "").strip()
    content = str(raw_report.get("content") or "").strip()
    if not title or not content:
        return None
    fmt = str(raw_report.get("format") or "markdown").lower()
    return {"title": title, "format": "html" if fmt == "html" else "markdown", "content": content}


async def run_agent(message: str, project=None, camera=None, layers=None, history=None) -> dict:
    client = get_client()
    contents = _build_contents(message, project, camera, layers, history)

    tool_config = types.GenerateContentConfig(
        system_instruction=SYSTEM_INSTRUCTION,
        tools=[SERVER_TOOL],
        temperature=0.4,
    )
    executed_tools = []
    for _ in range(MAX_TOOL_STEPS):
        resp = await client.aio.models.generate_content(model=config.MODEL, contents=contents, config=tool_config)
        candidate = resp.candidates[0] if resp.candidates else None
        if not candidate or not candidate.content or not candidate.content.parts:
            break
        contents.append(candidate.content)
        calls = [p.function_call for p in candidate.content.parts if p.function_call]
        if not calls:
            break
        response_parts = []
        for call in calls:
            args = dict(call.args or {})
            result = await server_tools.run_server_tool(client, call.name, args)
            executed_tools.append(call.name)
            response_parts.append(types.Part.from_function_response(name=call.name, response={"result": result}))
        contents.append(types.Content(role="user", parts=response_parts))

    contents.append(types.Content(role="user", parts=[types.Part(text=FINAL_INSTRUCTION)]))
    final_config = types.GenerateContentConfig(
        system_instruction=SYSTEM_INSTRUCTION,
        response_mime_type="application/json",
        response_schema=RESPONSE_SCHEMA,
        temperature=0.4,
    )
    resp = await client.aio.models.generate_content(model=config.MODEL, contents=contents, config=final_config)
    data = server_tools._extract_json(resp.text or "")
    if not isinstance(data, dict):
        data = {"reply": (resp.text or "").strip() or "応答を生成できませんでした", "actions": []}

    result = {
        "reply": str(data.get("reply") or "応答を生成できませんでした"),
        "actions": _sanitize_actions(data.get("actions")),
    }
    report = _sanitize_report(data.get("report"))
    if report:
        result["report"] = report
    if executed_tools:
        result["serverTools"] = executed_tools
    return result


def mock_response(message: str) -> dict:
    """ANTIGRAVITY_MOCK=1 時の固定応答。APIキーなしでの動作確認・フロント開発用"""
    reply = "[mock] ANTIGRAVITY モック応答です（Gemini 未接続）。指示: " + message[:100]
    result = {"reply": reply, "actions": [{"name": "listLayers", "args": {}}], "serverTools": []}
    if "資料" in message or "report" in message.lower():
        result["report"] = {
            "title": "サンプル資料（モック）",
            "format": "markdown",
            "content": "## 平面\n\n[視点](?longitude=136.97&latitude=35.24&height=3000&pitch=-45&heading=0)\n\n## 内容\n\nモック応答のため課題抽出は省略。\n\n## 解決案\n\nGEMINI_API_KEY を設定して再実行してください。",
        }
    return result
