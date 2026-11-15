// ogrsql: の QGIS ランタイム実行経路(フォールバック + 検証用)。
// 主経路は shared/ogr-sql.js のブラウザ内 JS 実装。本モジュールは
// JS 側で解決できない場合(QGIS プロジェクトレイヤー名参照・ローカル
// SHP/PostGIS 等の JS 非対応ソース・パーサ未対応構文)の救済と、
// GDAL をゴールデンオラクルとした差分検証に使う。
// ローカルで稼働する QGIS(geo_driver / geo_webview の Live relay)が
// 検出できた時だけ使い、ogr.ExecuteSQL(dialect="OGRSQL") による
// GDAL 本体の正規セマンティクスで実行する。
// 検出・接続・実行のどれかが失敗したら null を返す(呼び出し側は
// JS 側のエラーをそのまま伝播する)
import { backendUrl } from "./backend.js";
import { upsertMcpServer, connectMcpServer, callMcpTool, mcpRuntime, getMcpServer } from "./mcp.js";
import { parseOgrSelect } from "./ogr-sql.js";

// geo_webview 内蔵サーバの既定ポート帯(ai-chat.js の検出と同じ順序)
const QGIS_LIVE_PORTS = [8089, 8090, 8091];
const SERVER_KEY = "qgis-live";

let discoveryPromise = null;

async function discoverMcpUrl() {
  // (1) ローカルアプリ版: サーバの ~/.qgis-live レジストリ走査
  try {
    const res = await fetch(backendUrl("/api/qgis-live/discover"), { cache: "no-store" });
    if (res.ok && (await res.json())?.ok) return backendUrl("/api/qgis-live/mcp");
  } catch (e) { /* バックエンド未到達 = CDN/静的配信 */ }
  // (2) CDN/静的配信: geo_webview 内蔵サーバの /live/mcp-discover をプローブ
  const bases = QGIS_LIVE_PORTS.includes(Number(location.port)) ? [location.origin] : [];
  for (const p of QGIS_LIVE_PORTS) bases.push(`http://127.0.0.1:${p}`);
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/live/mcp-discover`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
      const info = res.ok ? await res.json() : null;
      if (info?.ok && info.url) return info.url;
    } catch (e) { /* geo_webview 未起動 */ }
  }
  return null;
}

// QGIS Live MCP へ接続済みかを確認し、未接続なら検出→接続を1回だけ試す。
// 2回目以降は検出結果を再利用する(QGIS 再起動時は呼び出し側で
// resetQgisOgrDiscovery() するか再接続ボタン経由で復帰する)
export function ensureQgisMcp() {
  if (mcpRuntime(SERVER_KEY).connected) return Promise.resolve(true);
  // MCP パネルで qgis-live を明示 OFF にした場合は自動接続・再有効化しない
  if (getMcpServer(SERVER_KEY)?.enabled === false) return Promise.resolve(false);
  if (!discoveryPromise) discoveryPromise = (async () => {
    const url = await discoverMcpUrl();
    if (!url) return false;
    upsertMcpServer({ key: SERVER_KEY, name: "QGIS Live", url, enabled: true });
    const r = await connectMcpServer(SERVER_KEY);
    return !!r?.ok;
  })();
  return discoveryPromise;
}

export function resetQgisOgrDiscovery() { discoveryPromise = null; }

// QGIS 内で実行する Python。ソース記述子を Memory データソースへ積み、
// ExecuteSQL(dialect="OGRSQL") の結果を GeoJSON テキストで result に入れる。
// 記述子: {geojson: FC} = ブラウザ側解決済み / {path} = ローカルパスやURL
// (QGIS 側ファイルアクセスが効く) / {qgisLayer: name} = プロジェクトレイヤー名
const PY_RUNNER = String.raw`
import json as _json
from osgeo import ogr as _ogr

def _fc_from_qgs_layer(_lyr):
    from qgis.core import (QgsCoordinateTransform,
        QgsCoordinateReferenceSystem, QgsProject)
    _wgs = QgsCoordinateReferenceSystem("EPSG:4326")
    _tr = None
    if _lyr.crs().isValid() and _lyr.crs() != _wgs:
        _tr = QgsCoordinateTransform(_lyr.crs(), _wgs, QgsProject.instance())
    _fields = [_fld.name() for _fld in _lyr.fields()]
    _feats = []
    for _f in _lyr.getFeatures():
        _props = {}
        for _i, _nm in enumerate(_fields):
            _v = _f.attributes()[_i] if _i < len(_f.attributes()) else None
            _props[_nm] = _v if _v is None or isinstance(_v, (str, int, float, bool)) else str(_v)
        _g = _f.geometry()
        if _g is not None and not _g.isNull():
            if _tr is not None:
                _g.transform(_tr)
            _geom = _json.loads(_g.asJson())
        else:
            _geom = None
        _feats.append({"type": "Feature", "id": _f.id(),
                       "geometry": _geom, "properties": _props})
    return {"type": "FeatureCollection", "features": _feats}

def _open_src(_desc):
    if "geojson" in _desc:
        return _ogr.Open(_json.dumps(_desc["geojson"]))
    if "path" in _desc:
        _p = _desc["path"]
        if _p.startswith("http://") or _p.startswith("https://"):
            _p = "/vsicurl/" + _p
        return _ogr.Open(_p)
    if "qgisLayer" in _desc:
        from qgis.core import QgsProject
        _want = _desc["qgisLayer"]
        _lyrs = QgsProject.instance().mapLayersByName(_want)
        if not _lyrs:
            # 表示名に無ければレイヤー ID(mapLayers() のキー)でも照合する
            _lyrs = [_l for _l in QgsProject.instance().mapLayers().values()
                     if _l.id() == _want]
        if not _lyrs:
            return None
        return _ogr.Open(_json.dumps(_fc_from_qgs_layer(_lyrs[0])))
    return None

_q = _json.loads(QGIS_OGR_QUERY)
_srcs = _json.loads(QGIS_OGR_SOURCES)
_ds = _ogr.GetDriverByName("Memory").CreateDataSource("mem")
_missing = []
for _name, _desc in _srcs.items():
    _sds = _open_src(_desc)
    _slyr = None
    if _sds is not None:
        _slyr = (_sds.GetLayerByName(_desc["layer"])
                 if "layer" in _desc else _sds.GetLayer(0))
    if _slyr is None:
        _missing.append(_name)
        continue
    _ds.CopyLayer(_slyr, _name)
if _missing:
    raise RuntimeError("ogrsql: 解決できないテーブル: " + ", ".join(_missing))
_rl = _ds.ExecuteSQL(_q, dialect="OGRSQL")
if _rl is None:
    raise RuntimeError("ogr.ExecuteSQL が NULL を返しました(クエリ構文エラーの可能性)")
def _jv(_v):
    try:
        _json.dumps(_v)
        return _v
    except TypeError:
        return str(_v)
_defn = _rl.GetLayerDefn()
_feats = []
for _f in _rl:
    _props = {}
    for _i in range(_defn.GetFieldCount()):
        _props[_defn.GetFieldDefn(_i).GetName()] = _jv(_f.GetField(_i))
    _g = _f.GetGeometryRef()
    _feat = {"type": "Feature", "geometry": _json.loads(_g.ExportToJson()) if _g else None,
             "properties": _props}
    _fid = _f.GetFID()
    if _fid is not None and _fid >= 0:
        _feat["id"] = _fid
    _feats.append(_feat)
_ds.ReleaseResultSet(_rl)
result = _json.dumps({"type": "FeatureCollection", "features": _feats}, ensure_ascii=False)
`;

// FROM/JOIN の参照名 → QGIS 側へ渡すソース記述子を組み立てる。
// resolveLayer(ref) はブラウザ側のレイヤー照合(GeoJSON 直送)に使う。
// 未解決の名前は QGIS プロジェクトレイヤー名として、パス/URL らしい
// 名前は QGIS 側で直接開く記述子として送る(相対参照は resolvePath で
// 絶対URL/パスへ解決済みのものを渡すこと。QGIS のカレントディレクトリは
// ブラウザのプロジェクト基準とは無関係なため)
function describeSource(ref, resolved, resolvePath = null) {
  if (resolved && typeof resolved === "object") return { geojson: resolved };
  if (ref.source) {
    return { path: resolvePath ? resolvePath(ref.source) : ref.source, layer: ref.name }; // 'ds'.layer 形式
  }
  const name = String(ref.name || "");
  if (/[/\\]/.test(name) || /^[a-z][a-z0-9+.-]*:\/\//i.test(name)
    || /\.(geojson|json|fgb|flatgeobuf|parquet|geoparquet|gpkg|kml|kmz|zip|shp|dbf|csv|tsv|sqlite|db)$/i.test(name)) {
    return { path: resolvePath ? resolvePath(name) : name };
  }
  return { qgisLayer: name };
}

// QGIS ランタイムで OGR SQL を実行し GeoJSON を返す。
// QGIS 未検出・未接続・実行失敗時は null(呼び出し側が JS 実装へ)。
// resolveLayer(ref) は省略可。FROM 参照は parseOgrSelect で抽出する
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// OGR SQL では FROM 'name' の単引用はデータソース(ファイル)指定で、
// 同一データソース内のレイヤー参照は "name"(二重引用)。QGIS 側は Memory
// データソースへ ref.name の名前で積むため、クエリ内の FROM/JOIN 参照を
// すべて "<ref.name>" へ書き換える('ds'.'layer' 形式も layer 名へ畳む)
export function rewriteQueryForQgis(query, refs) {
  let sql = String(query);
  for (const ref of refs) {
    if (ref.source) {
      const pat = new RegExp(
        `\\b(from|join)\\s+'${escRe(ref.source)}'\\s*\\.\\s*(?:'${escRe(ref.name)}'|"${escRe(ref.name)}"|${escRe(ref.name)})`, "gi");
      sql = sql.replace(pat, `$1 "${ref.name}"`);
    } else {
      const pat = new RegExp(`\\b(from|join)\\s+'${escRe(ref.name)}'(?!\\s*\\.)`, "gi");
      sql = sql.replace(pat, `$1 "${ref.name}"`);
    }
  }
  return sql;
}

export async function runOgrSqlViaQgis(query, resolveLayer = null, resolvePath = null) {
  try {
    if (!await ensureQgisMcp()) return null;
    const parsed = parseOgrSelect(query);
    const refs = [parsed.from, ...(parsed.joins || [])].filter(r => r && r.name);
    const sources = {};
    for (const ref of refs) {
      let resolved = null;
      if (resolveLayer && !ref.source) {
        try { resolved = await resolveLayer(ref); } catch (e) { /* QGIS 側解決へ */ }
      }
      sources[ref.name] = describeSource(ref, resolved, resolvePath);
    }
    const sql = rewriteQueryForQgis(query, refs);
    const code = PY_RUNNER
      .replace("QGIS_OGR_QUERY", JSON.stringify(JSON.stringify(sql)))
      .replace("QGIS_OGR_SOURCES", JSON.stringify(JSON.stringify(sources)));
    const res = await callMcpTool(SERVER_KEY, "qgis_pyeval", { code });
    if (!res?.ok || !res.text) return null;
    const fc = JSON.parse(res.text);
    return fc && fc.type === "FeatureCollection" ? fc : null;
  } catch (e) {
    console.warn("ogrsql: QGIS ランタイム実行に失敗(JS実装へフォールバック):", e);
    return null;
  }
}
