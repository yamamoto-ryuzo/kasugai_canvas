/*
 * kasc_loader.js — KASUGAI Canvas 形式(.kasc)レイヤー行パーサ + 形式ローダー
 *
 * geo_webview が生成する MapLibre / OpenLayers ビューア HTML に
 * インライン埋め込みされる共有モジュール。KASUGAI Canvas (web/app.js) の
 * データ取り込み機能をエンジン非依存で移植したもの。
 *
 *   KascLoader.parseLines(text)      → { items, skipped }
 *   KascLoader.load(item)            → Promise<GeoJSON FeatureCollection>
 *   KascLoader.loadFile(file, hint)  → Promise<{ type, geojson }>
 *   KascLoader.detectType(fileName)  → 'geojson'|'flatgeobuf'|'geoparquet'|'gpkg'|'csv'|'kasc'|null
 *   KascLoader.fcEnvelope(geojson)   → { west,south,east,north } | null
 *
 * サポートする行:
 *   xyz:/tile:/base:   タイルレイヤ (maxZoom=/minZoom=/opacity=/tileSize=/bbox=)
 *   wms:/wmts:         OGCタイル (wms=GetMap タイル化 / wmts=テンプレート or KVP GetTile)
 *   geojson:/layer:    GeoJSON 全件読込
 *   cms:               Re:Earth CMS Public API ({model} → .geojson 正規化。key= で Bearer 認証)
 *   geoparquet:/parquet:  GeoParquet (hyparquet)
 *   flatgeobuf:/fgb:   FlatGeobuf (公式 JS リーダー)
 *   gpkg:/geopackage:  GeoPackage (sql.js Worker。table=/where=/limit=/columns=/bbox=auto)
 *   duckdb:            DuckDB-Wasm SQL 絞り込み (where=/limit=/geom=/lon=/lat=/format=/columns=/covering=/bbox=auto/table=)
 *   sql:               任意 SELECT 文 (:bbox プレースホルダ対応)
 *   ogrsql:            OGR SQL SELECT 文 (shared/ogr-sql.js 動的import)
 *   mvt:/pmtiles:      ベクトルタイル(カタログ化のみ・描画はエンジン個別対応)
 * 3dtiles:/fly_geojson:/cam: 等はパースして skipped に振り分ける(呼び出し側で表示)。
 */
(function () {
  'use strict';

  var KascLoader = {};
  window.KascLoader = KascLoader;

  // ---------------------------------------------------------------
  // 基本ユーティリティ
  // ---------------------------------------------------------------
  var quoteSqlIdent = function (n) { return '"' + String(n).replace(/"/g, '""') + '"'; };
  var quoteSqlLiteral = function (v) { return "'" + String(v).replace(/'/g, "''") + "'"; };
  KascLoader.quoteSqlIdent = quoteSqlIdent;
  KascLoader.quoteSqlLiteral = quoteSqlLiteral;

  var sanitize = function (v) {
    return typeof v === 'bigint'
      ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString())
      : v;
  };

  // ---------------------------------------------------------------
  // WKB / GPkgBinary デコード(kasugai_canvas web/vector-decode.js 移植)
  // ---------------------------------------------------------------
  function wkbToGeoJsonGeometry(bytes) {
    if (!bytes || !bytes.byteLength) return null;
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var pos = 0;
    var readGeometry = function () {
      var littleEndian = view.getUint8(pos) === 1; pos += 1;
      var raw = view.getUint32(pos, littleEndian); pos += 4;
      var base = raw & 0xffff;
      var hasZ = (raw & 0x80000000) !== 0;
      var hasM = (raw & 0x40000000) !== 0;
      var hasSrid = (raw & 0x20000000) !== 0;
      if (!hasZ && !hasM && !hasSrid && raw >= 1000) {
        var variant = Math.floor(raw / 1000);
        hasZ = variant === 1 || variant === 3;
        hasM = variant === 2 || variant === 3;
        base = raw % 1000;
      }
      if (hasSrid) pos += 4;
      var count = function () { var n = view.getUint32(pos, littleEndian); pos += 4; return n; };
      var point = function () {
        var c = [view.getFloat64(pos, littleEndian), view.getFloat64(pos + 8, littleEndian)];
        pos += 16;
        if (hasZ) { c.push(view.getFloat64(pos, littleEndian)); pos += 8; }
        if (hasM) pos += 8;
        return c;
      };
      var points = function () { var a = new Array(count()); for (var i = 0; i < a.length; i++) a[i] = point(); return a; };
      var rings = function () { var a = new Array(count()); for (var i = 0; i < a.length; i++) a[i] = points(); return a; };
      var children = function () { var a = new Array(count()); for (var i = 0; i < a.length; i++) a[i] = readGeometry(); return a; };
      // 3点円弧の折線近似(Worker文字列版と同一ロジック)
      var strokeArc = function (p0, p1, p2, out) {
        var ax = p0[0], ay = p0[1], bx = p1[0], by = p1[1], cx = p2[0], cy = p2[1];
        var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        if (!isFinite(d) || Math.abs(d) < 1e-15) { out.push([cx, cy]); return; }
        var aa = ax * ax + ay * ay, bb = bx * bx + by * by, cc = cx * cx + cy * cy;
        var ux = (aa * (by - cy) + bb * (cy - ay) + cc * (ay - by)) / d;
        var uy = (aa * (cx - bx) + bb * (ax - cx) + cc * (bx - ax)) / d;
        var r = Math.sqrt((ax - ux) * (ax - ux) + (ay - uy) * (ay - uy));
        var t0 = Math.atan2(ay - uy, ax - ux);
        var t1 = Math.atan2(by - uy, bx - ux);
        var t2 = Math.atan2(cy - uy, cx - ux);
        var ccw = function (a) { while (a <= t0) a += 2 * Math.PI; return a; };
        if (ccw(t1) <= ccw(t2)) t2 = ccw(t2);
        else { var cw = function (a) { while (a >= t0) a -= 2 * Math.PI; return a; }; t2 = cw(t2); }
        var n = Math.max(4, Math.ceil(Math.abs(t2 - t0) / (Math.PI / 18)));
        for (var i = 1; i <= n; i++) {
          var t = t0 + (t2 - t0) * (i / n);
          out.push([ux + r * Math.cos(t), uy + r * Math.sin(t)]);
        }
      };
      var circularString = function () {
        var pts = points();
        var out = [];
        if (pts.length < 3) {
          for (var k = 0; k < pts.length; k++) out.push([pts[k][0], pts[k][1]]);
          return out;
        }
        out.push([pts[0][0], pts[0][1]]);
        var i = 0;
        for (; i + 2 < pts.length; i += 2) strokeArc(pts[i], pts[i + 1], pts[i + 2], out);
        for (; i < pts.length; i++) out.push([pts[i][0], pts[i][1]]);
        return out;
      };
      var joinCurveParts = function (geoms) {
        var out = [];
        for (var i = 0; i < geoms.length; i++) {
          var seg = geoms[i] && geoms[i].coordinates;
          if (!seg || !seg.length) continue;
          var part = out.length ? seg.slice(1) : seg;
          for (var j = 0; j < part.length; j++) out.push(part[j]);
        }
        return out;
      };
      var curveRings = function () {
        var a = new Array(count());
        for (var i = 0; i < a.length; i++) {
          var g = readGeometry();
          a[i] = g && g.coordinates ? g.coordinates : [];
        }
        return a;
      };
      var mapChildCoords = function () {
        var gs = children(), out = [];
        for (var i = 0; i < gs.length; i++) { if (gs[i] && gs[i].coordinates) out.push(gs[i].coordinates); }
        return out;
      };
      switch (base) {
        case 1: return { type: 'Point', coordinates: point() };
        case 2: return { type: 'LineString', coordinates: points() };
        case 3: return { type: 'Polygon', coordinates: rings() };
        case 4: return { type: 'MultiPoint', coordinates: mapChildCoords() };
        case 5: return { type: 'MultiLineString', coordinates: mapChildCoords() };
        case 6: return { type: 'MultiPolygon', coordinates: mapChildCoords() };
        case 7: return { type: 'GeometryCollection', geometries: children().filter(Boolean) };
        case 8: return { type: 'LineString', coordinates: circularString() };
        case 9: return { type: 'LineString', coordinates: joinCurveParts(children()) };
        case 10: return { type: 'Polygon', coordinates: curveRings() };
        case 11: return { type: 'MultiLineString', coordinates: mapChildCoords() };
        case 12: return { type: 'MultiPolygon', coordinates: mapChildCoords() };
        case 13: case 14: return null;
        case 15: case 16: return { type: 'MultiPolygon', coordinates: mapChildCoords() };
        case 17: return { type: 'Polygon', coordinates: rings() };
        default: return null;
      }
    };
    try { return readGeometry(); } catch (e) { return null; }
  }

  // GPkgBinary → WKB 部分切り出し
  function gpkgGeometryToWkb(value) {
    if (!(value instanceof Uint8Array) || value.length < 8 || value[0] !== 0x47 || value[1] !== 0x50) return null;
    var envelopeBytes = [0, 32, 48, 48, 64][(value[3] >> 1) & 0x07] || 0;
    var wkb = value.subarray(8 + envelopeBytes);
    return wkb.length ? wkb : null;
  }

  // GPkgBinary ヘッダのエンベロープ
  function gpkgGeometryEnvelope(value) {
    if (!(value instanceof Uint8Array) || value.length < 40 || value[0] !== 0x47 || value[1] !== 0x50) return null;
    var type = (value[3] >> 1) & 0x07;
    if (type < 1 || type > 4) return null;
    var little = (value[3] & 1) === 1;
    var view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    try {
      return { west: view.getFloat64(8, little), east: view.getFloat64(16, little), south: view.getFloat64(24, little), north: view.getFloat64(32, little) };
    } catch (e) { return null; }
  }

  function geoJsonGeometryEnvelope(geom) {
    var west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    var visit = function (coords) {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === 'number' && coords.length >= 2) {
        var x = coords[0], y = coords[1];
        if (Number.isFinite(x) && Number.isFinite(y)) {
          if (x < west) west = x;
          if (x > east) east = x;
          if (y < south) south = y;
          if (y > north) north = y;
        }
        return;
      }
      for (var i = 0; i < coords.length; i++) visit(coords[i]);
    };
    if (geom && geom.type === 'GeometryCollection') {
      for (var i = 0; i < (geom.geometries || []).length; i++) {
        var env = geoJsonGeometryEnvelope(geom.geometries[i]);
        if (env) {
          if (env.west < west) west = env.west;
          if (env.east > east) east = env.east;
          if (env.south < south) south = env.south;
          if (env.north > north) north = env.north;
        }
      }
    } else if (geom && geom.coordinates) {
      visit(geom.coordinates);
    }
    return west <= east && south <= north ? { west: west, south: south, east: east, north: north } : null;
  }

  // FeatureCollection 全体のエンベロープ
  KascLoader.fcEnvelope = function (geojson) {
    var west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    var features = (geojson && geojson.features) || (geojson && geojson.type === 'Feature' ? [geojson] : []);
    for (var i = 0; i < features.length; i++) {
      var env = geoJsonGeometryEnvelope(features[i] && features[i].geometry);
      if (!env) continue;
      if (env.west < west) west = env.west;
      if (env.east > east) east = env.east;
      if (env.south < south) south = env.south;
      if (env.north > north) north = env.north;
    }
    return west <= east && south <= north ? { west: west, south: south, east: east, north: north } : null;
  };

  // ---------------------------------------------------------------
  // .kasc 行パーサ
  // ---------------------------------------------------------------
  // parts[2] は出典スロット。key=value 形式なら出典ではなくオプションとして扱う
  function parseAttributionField(v) {
    if (v == null) return null;
    var s = String(v).trim();
    if (!s || /^(on|off|true|false)$/i.test(s) || s.indexOf('=') >= 0) return null;
    return s;
  }

  var LAYER_LINE_TYPES = {
    xyz: 1, tile: 1, base: 1,
    geojson: 1, layer: 1, cms: 1,
    geoparquet: 1, parquet: 1,
    flatgeobuf: 1, fgb: 1,
    gpkg: 1, geopackage: 1,
    duckdb: 1, sql: 1,
    '3dtiles': 1, '3d-tiles': 1, tiles3d: 1
  };

  // wms: 行 → WMS GetMap タイル URL テンプレート。
  // url が既に BBOX=/{bbox…} を含むならそのまま返す。
  // bboxToken: maplibre は '{bbox-epsg-3857}'、cesium は
  // '{westProjected},{southProjected},{eastProjected},{northProjected}'
  function wmsTileUrl(url, opt, bboxToken) {
    if (!url) return url;
    if (/[?&]bbox=/i.test(url) || /\{bbox/i.test(url)) return url;
    var version = String(opt.version || '1.1.1').trim();
    var srsKey = /^1\.3/.test(version) ? 'CRS' : 'SRS';
    var transparent = /^(false|0|off)$/i.test(String(opt.transparent != null ? opt.transparent : 'true')) ? 'FALSE' : 'TRUE';
    var size = Number(opt.tilesize || opt.tileSize) || 256;
    var params = [
      'SERVICE=WMS',
      'VERSION=' + encodeURIComponent(version),
      'REQUEST=GetMap',
      'LAYERS=' + encodeURIComponent(opt.layers != null ? opt.layers : ''),
      'STYLES=' + encodeURIComponent(opt.styles != null ? opt.styles : ''),
      'FORMAT=' + encodeURIComponent(opt.format || 'image/png'),
      'TRANSPARENT=' + transparent,
      srsKey + '=EPSG:3857',
      'BBOX=' + bboxToken,
      'WIDTH=' + size,
      'HEIGHT=' + size
    ];
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + params.join('&');
  }

  // wmts: 行 → {z}/{x}/{y} タイル URL テンプレートへ正規化。
  // {z}/{x}/{y} 済み → そのまま。{TileMatrix}/{TileRow}/{TileCol} の RESTful → 置換。
  // それ以外 → KVP GetTile(layer=/style=/tilematrixset=/format=/matrixprefix=)
  function wmtsTileUrl(url, opt) {
    if (!url) return url;
    if (/\{z\}/.test(url) && /\{x\}/.test(url) && /\{y\}/.test(url)) return url;
    if (/\{TileMatrix\}/.test(url) || /\{TileRow\}/.test(url) || /\{TileCol\}/.test(url)) {
      var tms = opt.tilematrixset || opt.matrixset || 'EPSG:3857';
      var style = opt.style || 'default';
      var fmt = String(opt.format || 'png').split('/').pop();
      return url
        .replace(/\{TileMatrixSet\}/g, encodeURIComponent(tms))
        .replace(/\{Style\}/g, encodeURIComponent(style))
        .replace(/\{Format\}/g, fmt)
        .replace(/\{TileMatrix\}/g, '{z}')
        .replace(/\{TileRow\}/g, '{y}')
        .replace(/\{TileCol\}/g, '{x}');
    }
    var params = [
      'SERVICE=WMTS',
      'REQUEST=GetTile',
      'VERSION=1.0.0',
      'LAYER=' + encodeURIComponent(opt.layer != null ? opt.layer : ''),
      'STYLE=' + encodeURIComponent(opt.style || 'default'),
      'TILEMATRIXSET=' + encodeURIComponent(opt.tilematrixset || opt.matrixset || 'EPSG:3857'),
      'FORMAT=' + encodeURIComponent(opt.format || 'image/png'),
      'TILEMATRIX=' + encodeURIComponent(opt.matrixprefix || '') + '{z}',
      'TILEROW={y}',
      'TILECOL={x}'
    ];
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + params.join('&');
  }
  KascLoader.wmsTileUrl = wmsTileUrl;
  KascLoader.wmtsTileUrl = wmtsTileUrl;

  KascLoader.parseLines = function (text) {
    var items = [];
    var skipped = [];
    var seq = 0;
    String(text || '').split(/\r\n|\r|\n/).forEach(function (raw) {
      var line = String(raw || '').trim();
      if (!line || line.indexOf('#') === 0 || line.indexOf('//') === 0) return;
      var m = /^([a-zA-Z][a-zA-Z0-9_-]*)\s*:(.*)$/.exec(line);
      if (!m) { skipped.push({ line: line, reason: 'not a layer line' }); return; }
      var type = m[1].toLowerCase();
      var value = (m[2] || '').trim();
      var id = 'kasc-' + (++seq);

      // ---- xyz:/tile:/base: タイル ----
      if (type === 'xyz' || type === 'tile' || type === 'base') {
        var parts = value.split('|').map(function (p) { return p.trim(); });
        var title = parts[0];
        var url = parts[1];
        var visible = !parts.some(function (p) { return /^(off|false)$/i.test(p); });
        var opt = {};
        parts.slice(2).forEach(function (p) {
          var eq = p.indexOf('=');
          var key = eq < 0 ? p.trim() : p.slice(0, eq).trim();
          var rawv = eq < 0 ? '' : p.slice(eq + 1).trim();
          var num = Number(rawv);
          var kl = key.toLowerCase();
          if (kl === 'attr' || kl === 'attribution') opt.attribution = rawv;
          else if (kl === 'opacity' && Number.isFinite(num)) opt.opacity = Math.max(0, Math.min(1, num));
          else if ((kl === 'maximumlevel' || kl === 'maxzoom' || kl === 'max') && Number.isInteger(num)) opt.maxZoom = num;
          else if ((kl === 'minimumlevel' || kl === 'minzoom' || kl === 'min') && Number.isInteger(num)) opt.minZoom = num;
          else if (kl === 'tilesize' && (num === 256 || num === 512)) opt.tileSize = num;
          else if (kl === 'bbox' || kl === 'bounds' || kl === 'extent') {
            var nums = rawv.split(',').map(function (v) { return Number(v.trim()); });
            if (nums.length === 4 && nums.every(Number.isFinite)) opt.bbox = nums;
          }
        });
        // 出典スロット(3番目)が key=value でなければ attribution として扱う
        if (!opt.attribution) opt.attribution = parseAttributionField(parts[2]);
        if (!url || !/^https?:\/\//i.test(url)) {
          skipped.push({ line: line, reason: 'url required' });
          return;
        }
        items.push({
          id: id, kind: 'raster', type: type, isBase: type === 'base',
          title: title || url, url: url, visible: visible,
          attribution: opt.attribution || null, opacity: opt.opacity != null ? opt.opacity : 0.8,
          minZoom: opt.minZoom, maxZoom: opt.maxZoom, tileSize: opt.tileSize,
          bbox: opt.bbox || null, sourceLine: line
        });
        return;
      }

      // ---- wms:/wmts: OGCタイル ----
      // kind は 'raster'。wms は描画側が GetMap テンプレート(wmsTileUrl)を組み立て、
      // wmts は tileUrl に {z}/{x}/{y} テンプレートを保持する
      if (type === 'wms' || type === 'wmts') {
        var wparts = value.split('|').map(function (p) { return p.trim(); });
        var wtitle = wparts[0];
        var wurl = wparts[1];
        var wvisible = !wparts.some(function (p) { return /^(off|false)$/i.test(p); });
        if (!wtitle || !wurl || !/^https?:\/\//i.test(wurl)) {
          skipped.push({ line: line, reason: 'title|url required' });
          return;
        }
        var wopt = {};
        // 出典スロット(3番目)に key=value を書いた場合も拾えるよう slice(2) から走査する
        // (= を含まない先頭トークンは出典として parseAttributionField 側で処理)
        wparts.slice(2).forEach(function (p) {
          var eq = p.indexOf('=');
          if (eq < 0) return;
          wopt[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
        });
        var wnum = function (k) { var n = Number(wopt[k]); return Number.isFinite(n) ? n : undefined; };
        var witem = {
          id: id, kind: 'raster', type: type, title: wtitle, url: wurl,
          visible: wvisible,
          attribution: parseAttributionField(wparts[2]) || wopt.attr || wopt.attribution || null,
          opacity: wnum('opacity') != null ? Math.max(0, Math.min(1, wnum('opacity'))) : 0.8,
          ogc: wopt, sourceLine: line
        };
        if (type === 'wmts') witem.tileUrl = wmtsTileUrl(wurl, wopt);
        var ts = Number(wopt.tilesize);
        if (ts === 256 || ts === 512) witem.tileSize = ts;
        var mz = wopt.maxzoom != null ? wopt.maxzoom : wopt.maximumlevel;
        if (mz != null && Number.isInteger(Number(mz))) witem.maxZoom = Number(mz);
        var nz = wopt.minzoom != null ? wopt.minzoom : wopt.minimumlevel;
        if (nz != null && Number.isInteger(Number(nz))) witem.minZoom = Number(nz);
        if (wopt.bbox) {
          var bn = String(wopt.bbox).split(',').map(function (v) { return Number(v.trim()); });
          if (bn.length === 4 && bn.every(Number.isFinite)) witem.bbox = bn;
        }
        items.push(witem);
        return;
      }

      // ---- 3dtiles: 非対応としてパース ----
      if (type === '3dtiles' || type === '3d-tiles' || type === 'tiles3d') {
        var tp = value.split('|').map(function (p) { return p.trim(); });
        items.push({ id: id, kind: 'unsupported', type: '3dtiles', title: tp[0] || '3D Tiles', url: tp[1] || '', visible: true, sourceLine: line });
        return;
      }

      // ---- mvt:/pmtiles: ベクトルタイル ----
      // 描画はエンジン個別対応(MapLibre=ネイティブ / Cesium=ラスタライズ)。
      // この共通ローダーでは unsupported としてカタログ化する
      if (type === 'mvt' || type === 'pmtiles' || type === 'vectortile') {
        var mp = value.split('|').map(function (p) { return p.trim(); });
        items.push({ id: id, kind: 'unsupported', type: type, title: mp[0] || 'Vector tiles', url: mp[1] || '', visible: true, sourceLine: line });
        return;
      }

      // ---- sql:/ogrsql: 任意クエリ ----
      if (type === 'sql' || type === 'ogrsql') {
        var firstSep = value.indexOf('|');
        var stitle = firstSep < 0 ? '' : value.slice(0, firstSep).trim();
        var query = firstSep < 0 ? '' : value.slice(firstSep + 1).trim();
        var svisible = true;
        var tailRe = /\|\s*(off|false|attr(?:ibution)?\s*=[^|]*|cluster\s*=\s*[a-z0-9]+|heat(?:map)?\s*=\s*[a-z0-9]+)\s*$/i;
        var tail;
        while ((tail = tailRe.exec(query))) {
          var seg = tail[1].trim();
          var attrM = /^attr(?:ibution)?\s*=\s*(.*)$/i.exec(seg);
          if (attrM) { /* 出典は現在未使用 */ }
          else if (/^(off|false)$/i.test(seg)) svisible = false;
          else break;
          query = query.slice(0, tail.index).trim();
        }
        if (!stitle || !query) { skipped.push({ line: line, reason: type + ': title|query required' }); return; }
        items.push({ id: id, kind: 'vector', type: type, title: stitle, query: query, visible: svisible, sourceLine: line });
        return;
      }

      // ---- ベクター系 (geojson/geoparquet/flatgeobuf/gpkg/duckdb) ----
      if (LAYER_LINE_TYPES[type]) {
        // where= は行の最終オプション: 先頭が where= のフィールド以降は
        // 行末まで値として1フィールドに結合する(式中に | を含んでよい)
        var vraw = value.split('|');
        var vparts = null;
        for (var wi = 0; wi < vraw.length; wi++) {
          if (/^\s*where\s*=/i.test(vraw[wi])) {
            vparts = vraw.slice(0, wi);
            vparts.push(vraw.slice(wi).join('|'));
            break;
          }
        }
        if (!vparts) vparts = vraw;
        vparts = vparts.map(function (p) { return p.trim(); });
        var vtitle = vparts[0];
        var vurl = vparts[1];
        var vvisible = !vparts.some(function (p) { return /^(off|false)$/i.test(p); });
        if (!vtitle) { skipped.push({ line: line, reason: 'title required' }); return; }
        var vtype = (type === 'layer' || type === 'cms') ? 'geojson' : (type === 'parquet' ? 'geoparquet' : (type === 'fgb' ? 'flatgeobuf' : (type === 'geopackage' ? 'gpkg' : type)));
        var item = {
          id: id, kind: 'vector', type: vtype, title: vtitle, url: vurl || '',
          visible: vvisible, attribution: parseAttributionField(vparts[2]), sourceLine: line
        };
        // cms: Re:Earth CMS Public API のモデル URL を {model}.geojson へ正規化
        if (type === 'cms') { item.url = cmsGeoJsonUrl(vurl); item.cms = true; }
        var optStart = item.attribution ? 3 : 2;
        vparts.slice(optStart).forEach(function (p) {
          var eq = p.indexOf('=');
          if (eq < 0) return;
          var key = p.slice(0, eq).trim().toLowerCase();
          var rawv = p.slice(eq + 1).trim();
          var num = Number(rawv);
          if (key === 'where' && rawv) item.where = rawv;
          else if ((key === 'geom' || key === 'geometry') && rawv) item.geom = rawv;
          else if ((key === 'lon' || key === 'lng') && rawv) item.lon = rawv;
          else if (key === 'lat' && rawv) item.lat = rawv;
          else if (key === 'format' && rawv) item.format = rawv;
          else if ((key === 'columns' || key === 'cols') && rawv) item.columns = rawv.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          else if (key === 'covering' && rawv) item.covering = rawv.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          else if (key === 'table' && rawv) item.gpkgTable = rawv;
          else if (key === 'limit' && Number.isInteger(num) && num > 0) item.limit = Math.floor(num);
          else if (key === 'bbox') {
            if (/^(auto|on|true|view|viewport)$/i.test(rawv)) item.bboxAuto = true;
            else if (/^(off|none|false|static|manual)$/i.test(rawv)) item.bboxAuto = false;
          }
          else if ((key === 'attr' || key === 'attribution') && rawv) item.attribution = rawv;
          // key=<api_key>: 非公開 CMS プロジェクト等の Bearer 認証(geojson 系の
          // fetch 時に Authorization ヘッダとして送る)
          else if (key === 'key' && rawv) item.headers = { authorization: 'Bearer ' + rawv };
          // 縮尺表示(QGIS minimumScale/maximumScale): minScale=引き側限界
          // (分母大)、maxScale=寄り側限界(分母小)
          else if ((key === 'minscale' || key === 'maxscale') && Number.isFinite(num) && num > 0) {
            item[key === 'minscale' ? 'minScale' : 'maxScale'] = num;
          }
        });
        if (vtype === 'gpkg' || vtype === 'duckdb' || vtype === 'geoparquet') {
          if (item.bboxAuto === undefined) item.bboxAuto = true;
        }
        if (type === 'cms' && !item.url) {
          skipped.push({ line: line, reason: 'url required' });
          return;
        }
        if (vtype !== 'geojson' && !vurl && !item.file) {
          skipped.push({ line: line, reason: 'url required' });
          return;
        }
        items.push(item);
        return;
      }

      // fly_geojson:/cam:/legend:/info:/plugin:/cloud: 等はレイヤーではないためスキップ
      skipped.push({ line: line, reason: 'unsupported line type: ' + type });
    });
    return { items: items, skipped: skipped };
  };

  // ---------------------------------------------------------------
  // ファイル形式判定
  // ---------------------------------------------------------------
  KascLoader.detectType = function (name) {
    var n = String(name || '').toLowerCase();
    if (/\.geojson$|\.json$|\.jsonfg$/.test(n)) return 'geojson';
    if (/\.fgb$|\.flatgeobuf$|\.fgbz$|\.zst$/.test(n)) return 'flatgeobuf';
    if (/\.parquet$|\.geoparquet$/.test(n)) return 'geoparquet';
    if (/\.gpkg$|\.geopackage$/.test(n)) return 'gpkg';
    if (/\.csv$|\.tsv$/.test(n)) return 'csv';
    if (/\.kasc$|\.txt$/.test(n)) return 'kasc';
    return null;
  };

  // ---------------------------------------------------------------
  // GeoJSON
  // ---------------------------------------------------------------
  // cms: 行の URL 正規化。モデル URL 末尾の拡張子(.json/.csv 含む)は
  // .geojson へ置換、無ければ付加する。?query(page/limit/offset/
  // start_cursor 等のページネーション)・#hash はそのまま保持する
  function cmsGeoJsonUrl(url) {
    var m = /^([^?#]*)([?#][\s\S]*)?$/.exec(String(url || '').trim());
    var path = ((m && m[1]) || '').replace(/\/+$/, '');
    var suffix = (m && m[2]) || '';
    if (!path) return '';
    path = /\.(geojson|json|csv)$/i.test(path)
      ? path.replace(/\.(geojson|json|csv)$/i, '.geojson')
      : path + '.geojson';
    return path + suffix;
  }

  // CMS .geojson 全頁回収。page=/start_cursor= 等が URL に明示済みなら
  // 1頁のみ。継続指標(hasNext/totalCount/links.next/nextCursor)を追従し、
  // 無ければ page=N を繰り上げて空頁・同一応答(page 無視サーバ)で打ち止め
  function collectCmsGeoJson(item, opt, firstObj) {
    var merged = { type: 'FeatureCollection', features: (firstObj.features || []).slice() };
    if (/[?&](page|start_cursor|offset|limit|per_?page)=/i.test(item.url)) return merged;
    var hasNext = function (o) {
      if (!o || typeof o !== 'object') return null;
      if (o.hasNext === true || o.has_next === true) return true;
      if (o.hasNext === false || o.has_next === false) return false;
      var total = Number(o.totalCount != null ? o.totalCount : o.total);
      if (Number.isFinite(total)) return merged.features.length < total;
      var links = o.links || [];
      for (var i = 0; i < links.length; i++) {
        if (links[i] && (links[i].rel === 'next' || links[i].relation === 'next') && links[i].href) return links[i].href;
      }
      return null;
    };
    var obj = firstObj;
    var page = 1;
    var step = function () {
      if (page >= 100) return merged;
      var nx = hasNext(obj);
      if (nx === false) return merged;
      var next = typeof nx === 'string' ? nx
        : item.url + (item.url.indexOf('?') < 0 ? '?' : '&') + 'page=' + (page + 1);
      page += 1;
      return fetch(next, opt).then(function (res) {
        if (!res.ok) return merged;
        return res.json();
      }).then(function (obj2) {
        var feats = obj2 && obj2.features ? obj2.features : [];
        if (!feats.length) return merged;
        // page= 無視サーバは同じ1頁目を返す → 同一応答なら打ち止め
        if (page === 2 && feats.length === merged.features.length
            && JSON.stringify(feats[0] || null) === JSON.stringify(merged.features[0] || null)) return merged;
        merged.features.push.apply(merged.features, feats);
        obj = obj2;
        return step();
      });
    };
    return Promise.resolve(step());
  }
  function loadGeoJson(item) {
    if (item.data) return Promise.resolve(item.data);
    var opt = { mode: 'cors' };
    if (item.headers) opt.headers = item.headers;
    return fetch(item.url, opt).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (obj) {
      if (item.cms && obj && obj.type === 'FeatureCollection') {
        return collectCmsGeoJson(item, opt, obj);
      }
      return obj;
    }).then(function (obj) {
      // RFC 7946 §3: 単体 Feature/裸 Geometry も正当な GeoJSON → FC へ包む
      if (obj && obj.type === 'Feature') return { type: 'FeatureCollection', features: [obj] };
      if (obj && obj.type && obj.type !== 'FeatureCollection' && (obj.coordinates || obj.geometries)) {
        return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: obj, properties: {} }] };
      }
      return obj;
    }).then(function (fc) {
      // OGC JSON-FG (21-045r1): geometry が null で place が GeoJSON 型なら
      // place を geometry へ昇格。非WGS84 coordRefSys・立体型は警告
      applyJsonFg(fc, item);
      return fc;
    }).then(function (fc) {
      // simplestyle 色値の # 省略形を # 付きへ正規化(shared/vector-load.js 同規則)
      if (fc && fc.features) {
        var reBare = /^[0-9a-f]{3}$|^[0-9a-f]{4}$|^[0-9a-f]{6}$|^[0-9a-f]{8}$/i;
        fc.features.forEach(function (f) {
          var p = f && f.properties;
          if (!p) return;
          ['marker-color', 'stroke', 'fill', 'icon-color'].forEach(function (k) {
            if (typeof p[k] === 'string' && reBare.test(p[k].trim())) p[k] = '#' + p[k].trim();
          });
        });
      }
      return fc;
    });
  }

  var JSONFG_GEOM_TYPES = { Point: 1, MultiPoint: 1, LineString: 1, MultiLineString: 1,
    Polygon: 1, MultiPolygon: 1, GeometryCollection: 1 };
  var JSONFG_WGS84 = /\/crs\/(OGC\/0\/CRS84h?|EPSG\/0\/(4326|4269|4612|6668))$/i;
  function jsonFgCrsHrefs(v, out) {
    if (v == null) return;
    if (typeof v === 'string') out.push(v);
    else if (v && v.length !== undefined && typeof v !== 'string' && v.forEach) v.forEach(function (x) { jsonFgCrsHrefs(x, out); });
    else if (typeof v === 'object') jsonFgCrsHrefs(v.href || v.uri, out);
  }
  function applyJsonFg(fc, item) {
    if (!fc || !fc.features) return;
    var warn = function (msg) { console.warn('JSON-FG (' + (item && item.title || item && item.url || '') + '): ' + msg); };
    var checkCrs = function (ref) {
      if (ref == null) return;
      var hrefs = [];
      jsonFgCrsHrefs(ref, hrefs);
      var ok = !hrefs.length || hrefs.every(function (h) { return JSONFG_WGS84.test(String(h)); });
      if (!ok) warn('非WGS84の coordRefSys — 再投影未対応のため place の表示位置がずれます ' + JSON.stringify(ref).slice(0, 120));
    };
    checkCrs(fc.coordRefSys);
    var solid = {};
    fc.features.forEach(function (f) {
      if (!f) return;
      checkCrs(f.coordRefSys);
      // time メンバー → properties.time へ昇格(属性表・時系列フィルタ用)
      if (f.time != null) {
        var tp = f.properties || (f.properties = {});
        if (tp.time == null) tp.time = f.time.date || f.time.timestamp || f.time.interval;
      }
      var p = f.place;
      if (p && typeof p === 'object') {
        checkCrs(p.coordRefSys);
        if (f.geometry == null) {
          if (JSONFG_GEOM_TYPES[p.type]) f.geometry = p;
          else if (p.type === 'Prism' || p.type === 'MultiPrism') {
            // Prism={base,lower,upper}/MultiPrism={prisms:[Prism]} → base を
            // フットプリント昇格し、鉛直範囲を __kasc_z/__kasc_extrude へ保持
            var prisms = p.type === 'Prism' ? [p] : (p.prisms || []);
            var bases = prisms.map(function (q) { return q && q.base; }).filter(function (b) { return b && JSONFG_GEOM_TYPES[b.type]; });
            if (bases.length) {
              f.geometry = bases.length === 1 ? { type: bases[0].type, coordinates: bases[0].coordinates }
                : bases.every(function (b) { return b.type === 'Polygon'; })
                  ? { type: 'MultiPolygon', coordinates: bases.map(function (b) { return b.coordinates; }) }
                  : { type: 'GeometryCollection', geometries: bases };
              var lows = prisms.map(function (q) { return Number(q && q.lower != null ? q.lower : 0); }).filter(Number.isFinite);
              var highs = prisms.map(function (q) { return Number(q && q.upper); }).filter(Number.isFinite);
              var pp = f.properties || (f.properties = {});
              if (lows.length) pp.__kasc_z = Math.min.apply(null, lows);
              if (highs.length) pp.__kasc_extrude = Math.max.apply(null, highs) - (lows.length ? Math.min.apply(null, lows) : 0);
            } else {
              solid[p.type] = 1;
            }
          } else {
            solid[p.type || 'unknown'] = 1;
          }
        }
      }
    });
    var solidTypes = Object.keys(solid);
    if (solidTypes.length) {
      warn('未対応の JSON-FG ジオメトリ型が含まれます: ' + solidTypes.join(', ') + '(geometry フォールバックの無い地物は描画されません)');
    }
  }

  // ---------------------------------------------------------------
  // FlatGeobuf (CDN lazy import)
  // ---------------------------------------------------------------
  // geojson.deserialize ではなく generic.deserialize + 自前 fromFeature を使う
  // (vector-load.js の loadFgbDecoder と同じ規則)。理由: Json 列の値が JSON
  // として不正だと geojson 側 fromFeature の JSON.parse が例外を投げ、
  // レイヤー全体の読み込みが中断するため。Json→String 再パースで救出する
  var fgbPromise = null;
  function loadFlatGeobufModule() {
    if (!fgbPromise) {
      fgbPromise = Promise.all([
        import('https://cdn.jsdelivr.net/npm/flatgeobuf@4.6.1/lib/mjs/generic.js/+esm'),
        import('https://cdn.jsdelivr.net/npm/flatgeobuf@4.6.1/lib/mjs/geojson/geometry.js/+esm'),
      ]).then(function (mods) {
        var g = mods[0], geom = mods[1];
        var fromFeature = function (id, feature, header) {
          var properties = null;
          try { properties = g.parseProperties(feature, header.columns); }
          catch (e) {
            var cols = (header.columns || []).map(function (c) {
              return c.type === g.ColumnType.Json ? Object.assign({}, c, { type: g.ColumnType.String }) : c;
            });
            try { properties = g.parseProperties(feature, cols); } catch (e2) { /* 属性なしで通す */ }
          }
          return { type: 'Feature', id: id,
            geometry: geom.fromGeometry(feature.geometry(), header.geometryType), properties: properties };
        };
        return { deserialize: function (input, ctx) { return g.deserialize(input, Object.assign({ fromFeature: fromFeature }, ctx)); } };
      });
      fgbPromise.catch(function () { fgbPromise = null; });
    }
    return fgbPromise;
  }
  function loadFlatGeobufAsGeoJson(item) {
    return loadFlatGeobufModule().then(function (mod) {
      var sourcePromise;
      if (item.file) {
        sourcePromise = Promise.resolve(item.file.stream ? { body: item.file.stream(), bytes: function () { return item.file.arrayBuffer(); } } : null);
      } else {
        var fopt = { mode: 'cors' };
        // key= オプション由来の Bearer 認証(loadGeoJson と同じ規約)
        if (item.headers) fopt.headers = item.headers;
        sourcePromise = fetch(item.url, fopt).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return { body: res.body, bytes: function () { return fetch(item.url, fopt).then(function (r) { return r.arrayBuffer(); }); } };
        });
      }
      return sourcePromise.then(function (src) {
        if (!src || !src.body) throw new Error('empty response body');
        var features = [];
        var headerMetaFn = function (h) { item.fgbHeader = h; };
        var collect = function (iter) {
          var readNext = function () {
            return iter.next().then(function (r) {
              if (r.done) return { type: 'FeatureCollection', features: features };
              var f = r.value;
              if (f && f.geometry) {
                if (f.properties) {
                  Object.keys(f.properties).forEach(function (k) { f.properties[k] = sanitize(f.properties[k]); });
                }
                features.push(f);
              }
              return readNext();
            });
          };
          return readNext();
        };
        return collect(mod.deserialize(src.body, { headerMetaFn: headerMetaFn })).catch(function (e) {
          // seekable Zstandard 圧縮 FGB はバッファ読みで再試行
          if (!/not a flatgeobuf/i.test(String(e && e.message || e))) throw e;
          return src.bytes().then(function (buf) {
            return collect(mod.deserialize(new Uint8Array(buf), { seekableZstd: true, headerMetaFn: headerMetaFn }));
          });
        });
      });
    });
  }

  // ---------------------------------------------------------------
  // GeoParquet (hyparquet CDN lazy import)
  // ---------------------------------------------------------------
  // geo メタの crs が OGC:CRS84 と同等か(仕様の簡易判定: crs.id のみ見る。
  // 欠落=CRS84・明示 null=未定義)。vector-load.js の同名関数と同じ規則
  function geoParquetCrsIsWgs84(crs) {
    if (crs === undefined) return true;
    if (crs === null) return false;
    var id = crs && crs.id;
    if (!id || !id.authority) return false;
    return (id.authority === 'OGC' && id.code === 'CRS84')
      || (id.authority === 'EPSG' && Number(id.code) === 4326);
  }
  var pqPromise = null;
  function loadHyparquet() {
    if (!pqPromise) {
      pqPromise = Promise.all([
        import('https://cdn.jsdelivr.net/npm/hyparquet@1.33.1/+esm'),
        import('https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.3/+esm')
      ]).then(function (mods) {
        var hp = mods[0], hc = mods[1];
        return {
          parquetReadObjects: hp.parquetReadObjects,
          parquetMetadata: hp.parquetMetadataAsync || hp.parquetMetadata,
          asyncBufferFromUrl: hp.asyncBufferFromUrl,
          compressors: hc.compressors
        };
      });
      pqPromise.catch(function () { pqPromise = null; });
    }
    return pqPromise;
  }
  // covering.bbox の4パスを hyparquet filter のキー形式(ドット結合)で取り出す
  function geoParquetCoveringPaths(colMeta) {
    var bbox = colMeta && colMeta.covering && colMeta.covering.bbox;
    if (!bbox) return null;
    var path = function (key) {
      return Array.isArray(bbox[key]) && bbox[key].length ? bbox[key].join('.') : null;
    };
    var xmin = path('xmin'), ymin = path('ymin'), xmax = path('xmax'), ymax = path('ymax');
    return (xmin && ymin && xmax && ymax) ? { xmin: xmin, ymin: ymin, xmax: xmax, ymax: ymax } : null;
  }
  // bounds {ranges:[{west,east}],south,north} → covering 列への範囲フィルタ
  // (行グループ min/max 統計とページインデックスによる読み飛ばしが効く)
  function geoParquetCoveringFilter(refs, bounds) {
    var lonBlocks = bounds.ranges.map(function (r) {
      var a = {}, b = {};
      a[refs.xmin] = { $lte: r.east };
      b[refs.xmax] = { $gte: r.west };
      return { $and: [a, b] };
    });
    var yminF = {}, ymaxF = {};
    yminF[refs.ymin] = { $lte: bounds.north };
    ymaxF[refs.ymax] = { $gte: bounds.south };
    return { $and: [{ $or: lonBlocks }, yminF, ymaxF] };
  }
  // 行グループ geospatial_statistics.bbox で表示範囲と重ならないグループを
  // 読み飛ばす(covering 列の無い 2.0 ネイティブ型ファイル向け)。
  // 統計を持つグループが無ければ null、あれば残存行範囲 [start,end) を返す
  function geoParquetStatPrunedRanges(meta, geomColumn, bounds) {
    if (!meta || !meta.row_groups || !meta.row_groups.length || !geomColumn) return null;
    var sawStats = false, kept = [], rowStart = 0;
    for (var i = 0; i < meta.row_groups.length; i++) {
      var rg = meta.row_groups[i];
      var n = Number(rg.num_rows) || 0;
      var col = (rg.columns || []).find(function (c) {
        var p = c && c.meta_data && c.meta_data.path_in_schema;
        return Array.isArray(p) && p.join('.') === geomColumn;
      });
      var bb = col && col.meta_data && col.meta_data.geospatial_statistics && col.meta_data.geospatial_statistics.bbox;
      var keep = true; // 統計が無いグループは保守的に残す
      if (bb && [bb.xmin, bb.ymin, bb.xmax, bb.ymax].every(Number.isFinite)) {
        sawStats = true;
        keep = bounds.ranges.some(function (r) { return bb.xmin <= r.east && bb.xmax >= r.west; })
          && bb.ymin <= bounds.north && bb.ymax >= bounds.south;
      }
      if (keep) {
        var last = kept[kept.length - 1];
        if (last && last[1] === rowStart) last[1] = rowStart + n;
        else kept.push([rowStart, rowStart + n]);
      }
      rowStart += n;
    }
    return sawStats ? kept : null;
  }
  // GeoJSON ジオメトリのエンベロープ [minX,minY,maxX,maxY]
  function geoJsonGeometryEnvelope(geom) {
    if (!geom) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var walk = function (coords) {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === 'number') {
        var x = coords[0], y = coords[1] || 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        return;
      }
      coords.forEach(walk);
    };
    if (geom.type === 'GeometryCollection') (geom.geometries || []).forEach(walk);
    else walk(geom.coordinates);
    return minX === Infinity ? null : [minX, minY, maxX, maxY];
  }
  // bbox=auto(bboxBounds 指定)時は covering.bbox 列 → 行グループ geospatial
  // statistics の順で部分読みを試みる。どちらも無い・Range 非対応サーバ・
  // 非 CRS84 は全件読みへフォールバックし item._gpRanged=false を立てる
  // (vector-load.js の loadGeoParquet と同じ規則)
  function loadGeoParquetAsGeoJson(item) {
    return loadHyparquet().then(function (mod) {
      var fileP;
      var sawPartial = { v: false };
      var wantBounds = item.bboxAuto !== false && item.bboxBounds
        && Array.isArray(item.bboxBounds.ranges) && item.bboxBounds.ranges.length;
      if (item.file) {
        fileP = item.file.arrayBuffer();
      } else {
        try {
          fileP = mod.asyncBufferFromUrl({
            url: item.url,
            // 206 を観測して Range 対応を判定する(非対応サーバは初回 slice で
            // 全量取得する。部分結果を返すと再クエリされず地物が欠ける)
            fetch: wantBounds ? function (u, init) {
              return fetch(u, init).then(function (res) {
                if (res.status === 206) sawPartial.v = true;
                return res;
              });
            } : undefined
          });
        } catch (e) { fileP = Promise.reject(e); }
        fileP = fileP.catch(function () {
          return fetch(item.url, { mode: 'cors' }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.arrayBuffer();
          });
        });
      }
      return fileP.then(function (file) {
        return Promise.resolve(mod.parquetMetadata ? mod.parquetMetadata(file) : null)
          .catch(function () { return null; })
          .then(function (meta) {
            var geo = null;
            try {
              var kv = meta && (meta.key_value_metadata || meta.metadata || []);
              var entry = Array.isArray(kv) ? kv.find(function (it) { return it && it.key === 'geo'; }) : (kv instanceof Map ? { value: kv.get('geo') } : null);
              var rawGeo = entry && entry.value;
              var geoText = rawGeo instanceof Uint8Array ? new TextDecoder().decode(rawGeo) : rawGeo;
              geo = geoText ? JSON.parse(geoText) : null;
            } catch (e) {}
            var primary = geo && geo.primary_column || null;
            var colMeta = primary && geo && geo.columns ? geo.columns[primary] : null;
            var bounds = (wantBounds && sawPartial.v && (!colMeta || geoParquetCrsIsWgs84(colMeta.crs))) ? item.bboxBounds : null;
            var postFilter = false;
            var readP = null;
            if (bounds) {
              var refs = geoParquetCoveringPaths(colMeta);
              if (refs) {
                readP = mod.parquetReadObjects({
                  file: file, compressors: mod.compressors, metadata: meta, usePageIndex: true,
                  filter: geoParquetCoveringFilter(refs, bounds)
                }).then(function (rows) { return { rows: rows, ranged: true }; })
                  .catch(function (e) {
                    console.warn('geoparquet 範囲読み(covering)失敗。全件へフォールバック: ' + item.url, e);
                    return null;
                  });
              } else {
                var runs = geoParquetStatPrunedRanges(meta, primary, bounds);
                if (runs) {
                  postFilter = true;
                  readP = runs.reduce(function (p, run) {
                    return p.then(function (acc) {
                      return mod.parquetReadObjects({ file: file, compressors: mod.compressors, metadata: meta, rowStart: run[0], rowEnd: run[1] })
                        .then(function (rows) { return acc.concat(rows); });
                    });
                  }, Promise.resolve([])).then(function (rows) { return { rows: rows, ranged: true }; })
                    .catch(function (e) {
                      console.warn('geoparquet 範囲読み(geospatial statistics)失敗。全件へフォールバック: ' + item.url, e);
                      return null;
                    });
                }
              }
            }
            var fullRead = function () {
              return mod.parquetReadObjects({ file: file, compressors: mod.compressors, metadata: meta })
                .then(function (rows) { return { rows: rows, ranged: false }; });
            };
            return (readP || fullRead()).then(function (r) { return r || fullRead(); })
              .then(function (r) {
                // bounds 未指定の初回全件読みで false を立てると以後の再クエリが
                // 永久に止まるため、範囲読みを実際に試みた時だけラッチする
                if (wantBounds) item._gpRanged = !!r.ranged;
                return { rows: r.rows || [], meta: meta, geo: geo, postFilter: postFilter && !!r.ranged, bounds: bounds };
              });
          });
      }).then(function (r0) {
        var rows = r0.rows;
        var geo = r0.geo;
        // geo メタ(version/crs/encoding/covering 等)を行アイテムへ保持
        if (geo) item.geoHeader = geo;
        if (!rows.length) return { type: 'FeatureCollection', features: [] };
        var geomColumn = geo && geo.primary_column || null;
        var colMeta = geomColumn && geo && geo.columns ? geo.columns[geomColumn] : null;
        if (colMeta && colMeta.encoding && colMeta.encoding !== 'WKB') {
          console.warn('geoparquet: geometry encoding "' + colMeta.encoding + '" is not supported (WKB only)');
        }
        if (colMeta && !geoParquetCrsIsWgs84(colMeta.crs)) {
          console.warn('geoparquet: CRS is not OGC:CRS84; coordinates may be misplaced', colMeta.crs == null ? '(undefined)' : colMeta.crs);
        }
        var isGeom = function (v) {
          return v instanceof Uint8Array || (v && typeof v === 'object' && typeof v.type === 'string' && ('coordinates' in v || 'geometries' in v));
        };
        var firstRow = rows[0];
        if (!geomColumn || !(geomColumn in firstRow)) {
          geomColumn = ('geometry' in firstRow) ? 'geometry' : Object.keys(firstRow).find(function (k) { return isGeom(firstRow[k]); });
        }
        if (!geomColumn) throw new Error('geometry column not found');
        // 属性から除外: geo.columns 全ジオメトリ列 + covering.bbox 参照列
        var excluded = {};
        if (geo && geo.columns) Object.keys(geo.columns).forEach(function (k) { excluded[k] = 1; });
        var covXmin = colMeta && colMeta.covering && colMeta.covering.bbox && colMeta.covering.bbox.xmin;
        if (Array.isArray(covXmin) && typeof covXmin[0] === 'string') excluded[covXmin[0]] = 1;
        var features = [];
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var value = row[geomColumn];
          var geometry = value instanceof Uint8Array ? wkbToGeoJsonGeometry(value) : (isGeom(value) ? value : null);
          if (!geometry) continue;
          if (r0.postFilter && r0.bounds) {
            // 行グループ統計は包絡でしかないため個別地物でも厳密に範囲判定する。
            // 包絡が取れないジオメトリは保守的に残す
            var env = geoJsonGeometryEnvelope(geometry);
            if (env && !(r0.bounds.ranges.some(function (r) { return env[0] <= r.east && env[2] >= r.west; })
              && env[1] <= r0.bounds.north && env[3] >= r0.bounds.south)) continue;
          }
          var properties = {};
          var keys = Object.keys(row);
          for (var j = 0; j < keys.length; j++) { if (keys[j] !== geomColumn && !excluded[keys[j]]) properties[keys[j]] = sanitize(row[keys[j]]); }
          features.push({ type: 'Feature', geometry: geometry, properties: properties });
        }
        return { type: 'FeatureCollection', features: features };
      });
    });
  }

  // ---------------------------------------------------------------
  // GeoPackage (sql.js blob Worker。kasugai gpkg-worker.js 移植)
  // ---------------------------------------------------------------
  // Worker ソースはテンプレートリテラル内に埋め込むため ${ } と
  // バッククォートは使わない。importScripts は UMD 版 sql.js を使う。
  var GPKG_WORKER_SRC = [
    'var SQL_JS_VERSION = "1.16.0";',
    'var sqlJsPromise = null;',
    'function loadSqlJs() {',
    '  if (!sqlJsPromise) {',
    '    sqlJsPromise = new Promise(function (resolve, reject) {',
    '      try {',
    '        importScripts("https://cdn.jsdelivr.net/npm/sql.js@" + SQL_JS_VERSION + "/dist/sql-wasm.js");',
    '        var init = self.initSqlJs || self.Module;',
    '        if (typeof init !== "function" && init && typeof init.default === "function") init = init.default;',
    '        if (typeof init !== "function") throw new Error("initSqlJs not found");',
    '        init({ locateFile: function (f) { return "https://cdn.jsdelivr.net/npm/sql.js@" + SQL_JS_VERSION + "/dist/" + f; } }).then(resolve, reject);',
    '      } catch (e) { reject(e); }',
    '    });',
    '    sqlJsPromise.catch(function () { sqlJsPromise = null; });',
    '  }',
    '  return sqlJsPromise;',
    '}',
    '',
    '// 再投影用。非経緯度 CRS の GPKG が出た時だけ遅延ロード(geotiff-layer.js と同ピン)',
    'var PROJ4_VERSION = "2.23.0";',
    'var proj4Promise = null;',
    'function loadProj4() {',
    '  if (!proj4Promise) {',
    '    proj4Promise = new Promise(function (resolve, reject) {',
    '      try {',
    '        importScripts("https://cdn.jsdelivr.net/npm/proj4@" + PROJ4_VERSION + "/dist/proj4-src.js");',
    '        if (typeof self.proj4 !== "function") throw new Error("proj4 not found");',
    '        resolve(self.proj4);',
    '      } catch (e) { reject(e); }',
    '    });',
    '    proj4Promise.catch(function () { proj4Promise = null; });',
    '  }',
    '  return proj4Promise;',
    '}',
    '',
    'var transforms = new Map();',
    'function mercatorToLonLat(x, y) {',
    '  var R = 6378137;',
    '  return [x / R * 180 / Math.PI, (Math.atan(Math.exp(y / R)) * 2 - Math.PI / 2) * 180 / Math.PI];',
    '}',
    'function buildTransform(entry, srsId) {',
    '  if (!entry || isGeographicSrs(entry, srsId) !== false) return Promise.resolve(null);',
    '  if (entry.code === 3857 || srsId === 3857) {',
    '    return Promise.resolve({ fn: mercatorToLonLat, method: "EPSG:3857 数式" });',
    '  }',
    '  var wkts = [entry.definition, entry.definition12];',
    '  var chain = Promise.resolve(null);',
    '  var tryWkt = function (i) {',
    '    if (i >= wkts.length) return Promise.resolve(null);',
    '    var s = String(wkts[i] || "");',
    '    s = s.replace(/^\\s+|\\s+$/g, "");',
    '    if (!s || s.toLowerCase() === "undefined") return tryWkt(i + 1);',
    '    return loadProj4().then(function (proj4) {',
    '      var name = "GPKG" + srsId;',
    '      proj4.defs(name, s);',
    '      var t = proj4(name, "EPSG:4326", [1000, 1000]);',
    '      if (!Number.isFinite(t[0]) || !Number.isFinite(t[1])) throw new Error("non-finite");',
    '      return { fn: function (x, y) { return proj4(name, "EPSG:4326", [x, y]); }, method: "GPKG 内蔵 WKT" };',
    '    }).catch(function () { return tryWkt(i + 1); });',
    '  };',
    '  return tryWkt(0).then(function (t) {',
    '    if (t) return t;',
    '    if (!/^EPSG$/i.test(String(entry.org || "")) || !Number.isFinite(entry.code) || entry.code <= 0) return null;',
    '    return loadProj4().then(function (proj4) {',
    '      return fetch("https://epsg.io/" + entry.code + ".proj4").then(function (res) {',
    '        if (!res.ok) return null;',
    '        return res.text().then(function (def) {',
    '          proj4.defs("EPSG:" + entry.code, def);',
    '          var t = proj4("EPSG:" + entry.code, "EPSG:4326", [1000, 1000]);',
    '          if (!Number.isFinite(t[0]) || !Number.isFinite(t[1])) throw new Error("non-finite");',
    '          return { fn: function (x, y) { return proj4("EPSG:" + entry.code, "EPSG:4326", [x, y]); },',
    '            method: "epsg.io EPSG:" + entry.code };',
    '        });',
    '      });',
    '    }).catch(function () { return null; });',
    '  });',
    '}',
    'function resolveTransform(url, srsId, meta) {',
    '  var key = url + "|" + srsId;',
    '  var p = transforms.get(key);',
    '  if (!p) {',
    '    p = buildTransform(meta && meta.srs ? meta.srs[srsId] : null, srsId).catch(function () { return null; });',
    '    transforms.set(key, p);',
    '  }',
    '  return p;',
    '}',
    '',
    'var quoteIdent = function (n) { return \'"\' + String(n).replace(/"/g, \'""\') + \'"\'; };',
    'var quoteLit = function (v) { return "\'" + String(v).replace(/\'/g, "\'\'") + "\'"; };',
    'function sanitize(v) { return typeof v === "bigint" ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()) : v; }',
    '',
    'function wkbToGeoJsonGeometry(bytes) {',
    '  if (!bytes || !bytes.byteLength) return null;',
    '  var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);',
    '  var pos = 0;',
    '  var readGeometry = function () {',
    '    var littleEndian = view.getUint8(pos) === 1; pos += 1;',
    '    var raw = view.getUint32(pos, littleEndian); pos += 4;',
    '    var base = raw & 0xffff;',
    '    var hasZ = (raw & 0x80000000) !== 0;',
    '    var hasM = (raw & 0x40000000) !== 0;',
    '    var hasSrid = (raw & 0x20000000) !== 0;',
    '    if (!hasZ && !hasM && !hasSrid && raw >= 1000) {',
    '      var variant = Math.floor(raw / 1000);',
    '      hasZ = variant === 1 || variant === 3;',
    '      hasM = variant === 2 || variant === 3;',
    '      base = raw % 1000;',
    '    }',
    '    if (hasSrid) pos += 4;',
    '    var count = function () { var n = view.getUint32(pos, littleEndian); pos += 4; return n; };',
    '    var point = function () {',
    '      var c = [view.getFloat64(pos, littleEndian), view.getFloat64(pos + 8, littleEndian)];',
    '      pos += 16;',
    '      if (hasZ) { c.push(view.getFloat64(pos, littleEndian)); pos += 8; }',
    '      if (hasM) pos += 8;',
    '      return c;',
    '    };',
    '    var points = function () { var a = new Array(count()); for (var i = 0; i < a.length; i++) a[i] = point(); return a; };',
    '    var rings = function () { var a = new Array(count()); for (var i = 0; i < a.length; i++) a[i] = points(); return a; };',
    '    var children = function () { var a = new Array(count()); for (var i = 0; i < a.length; i++) a[i] = readGeometry(); return a; };',
    '    var strokeArc = function (p0, p1, p2, out) {',
    '      var ax = p0[0], ay = p0[1], bx = p1[0], by = p1[1], cx = p2[0], cy = p2[1];',
    '      var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));',
    '      if (!isFinite(d) || Math.abs(d) < 1e-15) { out.push([cx, cy]); return; }',
    '      var aa = ax * ax + ay * ay, bb = bx * bx + by * by, cc = cx * cx + cy * cy;',
    '      var ux = (aa * (by - cy) + bb * (cy - ay) + cc * (ay - by)) / d;',
    '      var uy = (aa * (cx - bx) + bb * (ax - cx) + cc * (bx - ax)) / d;',
    '      var r = Math.sqrt((ax - ux) * (ax - ux) + (ay - uy) * (ay - uy));',
    '      var t0 = Math.atan2(ay - uy, ax - ux);',
    '      var t1 = Math.atan2(by - uy, bx - ux);',
    '      var t2 = Math.atan2(cy - uy, cx - ux);',
    '      var ccw = function (a) { while (a <= t0) a += 2 * Math.PI; return a; };',
    '      if (ccw(t1) <= ccw(t2)) t2 = ccw(t2);',
    '      else { var cw = function (a) { while (a >= t0) a -= 2 * Math.PI; return a; }; t2 = cw(t2); }',
    '      var n = Math.max(4, Math.ceil(Math.abs(t2 - t0) / (Math.PI / 18)));',
    '      for (var i = 1; i <= n; i++) {',
    '        var t = t0 + (t2 - t0) * (i / n);',
    '        out.push([ux + r * Math.cos(t), uy + r * Math.sin(t)]);',
    '      }',
    '    };',
    '    var circularString = function () {',
    '      var pts = points();',
    '      var out = [];',
    '      if (pts.length < 3) {',
    '        for (var k = 0; k < pts.length; k++) out.push([pts[k][0], pts[k][1]]);',
    '        return out;',
    '      }',
    '      out.push([pts[0][0], pts[0][1]]);',
    '      var i = 0;',
    '      for (; i + 2 < pts.length; i += 2) strokeArc(pts[i], pts[i + 1], pts[i + 2], out);',
    '      for (; i < pts.length; i++) out.push([pts[i][0], pts[i][1]]);',
    '      return out;',
    '    };',
    '    var joinCurveParts = function (geoms) {',
    '      var out = [];',
    '      for (var i = 0; i < geoms.length; i++) {',
    '        var seg = geoms[i] && geoms[i].coordinates;',
    '        if (!seg || !seg.length) continue;',
    '        var part = out.length ? seg.slice(1) : seg;',
    '        for (var j = 0; j < part.length; j++) out.push(part[j]);',
    '      }',
    '      return out;',
    '    };',
    '    var curveRings = function () {',
    '      var a = new Array(count());',
    '      for (var i = 0; i < a.length; i++) {',
    '        var g = readGeometry();',
    '        a[i] = g && g.coordinates ? g.coordinates : [];',
    '      }',
    '      return a;',
    '    };',
    '    var mapChildCoords = function () {',
    '      var gs = children(), out = [];',
    '      for (var i = 0; i < gs.length; i++) { if (gs[i] && gs[i].coordinates) out.push(gs[i].coordinates); }',
    '      return out;',
    '    };',
    '    switch (base) {',
    '      case 1: return { type: "Point", coordinates: point() };',
    '      case 2: return { type: "LineString", coordinates: points() };',
    '      case 3: return { type: "Polygon", coordinates: rings() };',
    '      case 4: return { type: "MultiPoint", coordinates: mapChildCoords() };',
    '      case 5: return { type: "MultiLineString", coordinates: mapChildCoords() };',
    '      case 6: return { type: "MultiPolygon", coordinates: mapChildCoords() };',
    '      case 7: return { type: "GeometryCollection", geometries: children().filter(Boolean) };',
    '      case 8: return { type: "LineString", coordinates: circularString() };',
    '      case 9: return { type: "LineString", coordinates: joinCurveParts(children()) };',
    '      case 10: return { type: "Polygon", coordinates: curveRings() };',
    '      case 11: return { type: "MultiLineString", coordinates: mapChildCoords() };',
    '      case 12: return { type: "MultiPolygon", coordinates: mapChildCoords() };',
    '      case 13: case 14: return null;',
    '      case 15: case 16: return { type: "MultiPolygon", coordinates: mapChildCoords() };',
    '      case 17: return { type: "Polygon", coordinates: rings() };',
    '      default: return null;',
    '    }',
    '  };',
    '  try { return readGeometry(); } catch (e) { return null; }',
    '}',
    '',
    'function gpkgGeometryToWkb(value) {',
    '  if (!(value instanceof Uint8Array) || value.length < 8 || value[0] !== 0x47 || value[1] !== 0x50) return null;',
    '  var envelopeBytes = [0, 32, 48, 48, 64][(value[3] >> 1) & 0x07] || 0;',
    '  var wkb = value.subarray(8 + envelopeBytes);',
    '  return wkb.length ? wkb : null;',
    '}',
    'function gpkgGeometryEnvelope(value) {',
    '  if (!(value instanceof Uint8Array) || value.length < 40 || value[0] !== 0x47 || value[1] !== 0x50) return null;',
    '  var type = (value[3] >> 1) & 0x07;',
    '  if (type < 1 || type > 4) return null;',
    '  var little = (value[3] & 1) === 1;',
    '  var view = new DataView(value.buffer, value.byteOffset, value.byteLength);',
    '  try { return { west: view.getFloat64(8, little), east: view.getFloat64(16, little), south: view.getFloat64(24, little), north: view.getFloat64(32, little) }; } catch (e) { return null; }',
    '}',
    'function geoJsonGeometryEnvelope(geom) {',
    '  var west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;',
    '  var visit = function (coords) {',
    '    if (!coords || typeof coords.length !== "number") return;',
    '    if (typeof coords[0] === "number" && coords.length >= 2) {',
    '      var x = coords[0], y = coords[1];',
    '      if (isFinite(x) && isFinite(y)) {',
    '        if (x < west) west = x;',
    '        if (x > east) east = x;',
    '        if (y < south) south = y;',
    '        if (y > north) north = y;',
    '      }',
    '      return;',
    '    }',
    '    for (var i = 0; i < coords.length; i++) visit(coords[i]);',
    '  };',
    '  if (geom && geom.type === "GeometryCollection") {',
    '    var gs = geom.geometries || [];',
    '    for (var i = 0; i < gs.length; i++) {',
    '      var env = geoJsonGeometryEnvelope(gs[i]);',
    '      if (env) {',
    '        if (env.west < west) west = env.west;',
    '        if (env.east > east) east = env.east;',
    '        if (env.south < south) south = env.south;',
    '        if (env.north > north) north = env.north;',
    '      }',
    '    }',
    '  } else if (geom && geom.coordinates) {',
    '    visit(geom.coordinates);',
    '  }',
    '  return west <= east && south <= north ? { west: west, south: south, east: east, north: north } : null;',
    '}',
    'function transformGeoJsonGeometry(geom, fn) {',
    '  if (!geom || !fn) return geom;',
    '  var visit = function (coords) {',
    '    if (!Array.isArray(coords)) return;',
    '    if (typeof coords[0] === "number" && coords.length >= 2) {',
    '      var p = fn(coords[0], coords[1]);',
    '      coords[0] = p[0]; coords[1] = p[1];',
    '      return;',
    '    }',
    '    for (var i = 0; i < coords.length; i++) visit(coords[i]);',
    '  };',
    '  if (geom.type === "GeometryCollection") {',
    '    for (var i = 0; i < (geom.geometries || []).length; i++) transformGeoJsonGeometry(geom.geometries[i], fn);',
    '  } else {',
    '    visit(geom.coordinates);',
    '  }',
    '  return geom;',
    '}',
    'function transformEnvelope(env, fn) {',
    '  if (!env || !fn) return env;',
    '  var pts = [fn(env.west, env.south), fn(env.east, env.south), fn(env.west, env.north), fn(env.east, env.north)];',
    '  var xs = [], ys = [];',
    '  for (var i = 0; i < pts.length; i++) {',
    '    if (Number.isFinite(pts[i][0])) xs.push(pts[i][0]);',
    '    if (Number.isFinite(pts[i][1])) ys.push(pts[i][1]);',
    '  }',
    '  if (!xs.length || !ys.length) return env;',
    '  return { west: Math.min.apply(null, xs), south: Math.min.apply(null, ys),',
    '    east: Math.max.apply(null, xs), north: Math.max.apply(null, ys) };',
    '}',
    'function envelopeIntersects(env, bbox) {',
    '  if (!env || !bbox) return true;',
    '  var south = Number(bbox.south), north = Number(bbox.north);',
    '  if (!(env.north >= south && env.south <= north)) return false;',
    '  return bbox.ranges.some(function (r) { return env.east >= Number(r.west) && env.west <= Number(r.east); });',
    '}',
    '',
    'var dbs = new Map();',
    'function dbKey(msg) {',
    '  if (msg.buffer) return "buffer:" + (msg.url || (msg.reqId || 0));',
    '  return msg.url || ("buffer:" + (msg.reqId || 0) + ":" + Math.random());',
    '}',
    '// 取得は url → 失敗時のみ directUrl(元URL)の順で試す(プロキシ失敗の退避)',
    'function fetchBytes(url, fallbackUrl) {',
    '  function get(u) {',
    '    return fetch(u).then(function (res) {',
    '      if (!res.ok) throw new Error("HTTP " + res.status);',
    '      return res.arrayBuffer();',
    '    });',
    '  }',
    '  return get(url).then(null, function (e) {',
    '    if (!fallbackUrl) throw e;',
    '    return get(fallbackUrl);',
    '  });',
    '}',
    'function openDb(msg) {',
    '  var key = dbKey(msg);',
    '  var promise = dbs.get(key);',
    '  if (!promise) {',
    '    promise = loadSqlJs().then(function (SQL) {',
    '      if (msg.buffer) return new SQL.Database(new Uint8Array(msg.buffer));',
    '      return fetchBytes(msg.url, msg.directUrl || null).then(function (buf) {',
    '        return new SQL.Database(new Uint8Array(buf));',
    '      });',
    '    });',
    '    promise.catch(function () { if (dbs.get(key) === promise) dbs.delete(key); });',
    '    dbs.set(key, promise);',
    '  }',
    '  return promise;',
    '}',
    '',
    'function tableColumns(db, name) {',
    '  var res = db.exec("PRAGMA table_info(" + quoteIdent(name) + ")");',
    '  var vals = (res[0] && res[0].values) || [];',
    '  return vals.map(function (row) { return row[1]; });',
    '}',
    '',
    'var metas = new Map();',
    'function readDbMeta(db) {',
    '  var meta = { extensions: [], tiles: [], kinds: {}, srs: {} };',
    '  try {',
    '    var res = db.exec("SELECT table_name, column_name, extension_name, scope FROM gpkg_extensions");',
    '    var vals = (res[0] && res[0].values) || [];',
    '    for (var i = 0; i < vals.length; i++) meta.extensions.push({ table: vals[i][0], column: vals[i][1], name: vals[i][2], scope: vals[i][3] });',
    '  } catch (e) {}',
    '  try {',
    '    var res2 = db.exec("SELECT table_name, data_type FROM gpkg_contents");',
    '    var vals2 = (res2[0] && res2[0].values) || [];',
    '    for (var i = 0; i < vals2.length; i++) {',
    '      meta.kinds[vals2[i][0]] = vals2[i][1];',
    '      if (vals2[i][1] === "tiles") meta.tiles.push(vals2[i][0]);',
    '    }',
    '  } catch (e) {}',
    '  try {',
    '    var cols = tableColumns(db, "gpkg_spatial_ref_sys");',
    '    var has12 = cols.indexOf("definition_12_063") >= 0;',
    '    var res3 = db.exec("SELECT srs_id, srs_name, organization, organization_coordsys_id, \\"definition\\"" + (has12 ? ", \\"definition_12_063\\"" : "") + " FROM gpkg_spatial_ref_sys");',
    '    var vals3 = (res3[0] && res3[0].values) || [];',
    '    for (var i = 0; i < vals3.length; i++) {',
    '      meta.srs[Number(vals3[i][0])] = { name: vals3[i][1], org: vals3[i][2], code: Number(vals3[i][3]), definition: vals3[i][4], definition12: has12 ? vals3[i][5] : null };',
    '    }',
    '  } catch (e) {}',
    // OGC 24-050 Portrayal 拡張(ドラフト)のスタイル登録表。module Worker と同じく
    // 登録内容を meta.styles として露出する(描画適用は未対応のため警告で通知)
    '  try {',
    '    var res4 = db.exec("SELECT id, style, description, uri FROM gpkgext_styles");',
    '    var vals4 = (res4[0] && res4[0].values) || [];',
    '    var stylesMap = {};',
    '    var order = [];',
    '    for (var i = 0; i < vals4.length; i++) {',
    '      var sid = Number(vals4[i][0]);',
    '      stylesMap[sid] = { id: sid, style: vals4[i][1], description: vals4[i][2] || null, uri: vals4[i][3] || null, formats: [] };',
    '      order.push(sid);',
    '    }',
    '    var sh = db.exec("SELECT style_id, format FROM gpkgext_stylesheets");',
    '    var vals5 = (sh[0] && sh[0].values) || [];',
    '    var orphan = 0;',
    '    for (var j = 0; j < vals5.length; j++) {',
    '      var s = stylesMap[Number(vals5[j][0])];',
    '      if (s) { if (vals5[j][1] && s.formats.indexOf(String(vals5[j][1])) < 0) s.formats.push(String(vals5[j][1])); }',
    '      else orphan++;',
    '    }',
    '    var list = order.map(function (id) { return stylesMap[id]; });',
    '    if (list.length || orphan) meta.styles = { list: list, orphanStylesheets: orphan };',
    '  } catch (e) {}',
    '  try {',
    '    var res5 = db.exec("SELECT COUNT(*) FROM gpkgext_symbols");',
    '    meta.symbolCount = Number((res5[0] && res5[0].values && res5[0].values[0] && res5[0].values[0][0]) || 0);',
    '  } catch (e) {}',
    '  try {',
    '    var res6 = db.exec("SELECT COUNT(*) FROM gpkgext_fonts");',
    '    meta.fontCount = Number((res6[0] && res6[0].values && res6[0].values[0] && res6[0].values[0][0]) || 0);',
    '  } catch (e) {}',
    // OGC 24-049 semantic-annotations(ドラフト): GeoDataClass 注釈と参照表
    '  try {',
    '    var res7 = db.exec("SELECT id, type, title, description, uri FROM gpkgext_semantic_annotations");',
    '    var vals7 = (res7[0] && res7[0].values) || [];',
    '    var annotations = {};',
    '    for (var i = 0; i < vals7.length; i++) {',
    '      annotations[Number(vals7[i][0])] = { id: Number(vals7[i][0]), type: vals7[i][1], title: vals7[i][2], description: vals7[i][3] || null, uri: vals7[i][4] || null };',
    '    }',
    '    if (Object.keys(annotations).length) meta.annotations = annotations;',
    '    var res8 = db.exec("SELECT table_name, key_column_name, key_value, sa_id FROM gpkgext_sa_reference");',
    '    var vals8 = (res8[0] && res8[0].values) || [];',
    '    var arefs = [];',
    '    for (var j = 0; j < vals8.length; j++) {',
    '      arefs.push({ table: vals8[j][0], keyColumn: vals8[j][1], key: Number(vals8[j][2]), saId: Number(vals8[j][3]) });',
    '    }',
    '    if (arefs.length) meta.annotationRefs = arefs;',
    '  } catch (e) {}',
    '  return meta;',
    '}',
    'function dbMetaFor(msg) {',
    '  var key = dbKey(msg);',
    '  var p = metas.get(key);',
    '  if (!p) {',
    '    p = openDb(msg).then(readDbMeta);',
    '    p.catch(function () { if (metas.get(key) === p) metas.delete(key); });',
    '    metas.set(key, p);',
    '  }',
    '  return p;',
    '}',
    '',
    'function isGeographicSrs(entry, srsId) {',
    '  if (srsId === -1) return false;',
    '  var def = String((entry && (entry.definition || entry.definition12)) || "");',
    '  if (/^\\s*(GEOGCS|GEODCRS|GEOGCRS|GEOGRAPHIC)/i.test(def)) return true;',
    '  if (def.replace(/^\\s+|\\s+$/g, "") && def.toLowerCase() !== "undefined") return false;',
    '  return null;',
    '}',
    '',
    'var warned = new Map();',
    'function freshWarnings(key, warnings) {',
    '  var seen = warned.get(key);',
    '  if (!seen) { seen = new Set(); warned.set(key, seen); }',
    '  return warnings.filter(function (w) {',
    '    if (seen.has(w)) return false;',
    '    seen.add(w);',
    '    return true;',
    '  });',
    '}',
    '',
    'function resolveFeatureTable(db, table, meta) {',
    '  var tableName = table || null;',
    '  if (!tableName) {',
    '    var res = db.exec("SELECT table_name FROM gpkg_geometry_columns ORDER BY rowid LIMIT 1");',
    '    tableName = (res[0] && res[0].values && res[0].values[0] && res[0].values[0][0]) || null;',
    '  }',
    '  if (!tableName) throw new Error("feature table not found");',
    '  var gres = db.exec("SELECT column_name, srs_id FROM gpkg_geometry_columns WHERE table_name = " + quoteLit(tableName) + " LIMIT 1");',
    '  var row = (gres[0] && gres[0].values && gres[0].values[0]) || null;',
    '  var kind = (meta && meta.kinds && meta.kinds[tableName]) || (row ? "features" : "attributes");',
    '  if (!row) {',
    '    var isFeatures = kind === "features";',
    '    return { tableName: tableName, geomCol: isFeatures ? "geom" : null, hasGeom: isFeatures,',
    '      srsId: null, kind: kind, unregistered: true };',
    '  }',
    '  return { tableName: tableName, geomCol: row[0] || "geom", hasGeom: true,',
    '    srsId: row[1] != null ? Number(row[1]) : null, kind: kind };',
    '}',
    '',
    'function tableWarnings(meta, t, reprojMethod) {',
    '  var warnings = [];',
    '  if (t.unregistered && t.kind !== "features") {',
    '    warnings.push("テーブル " + t.tableName + " は非空間(attributes)表です。地図には描画されません");',
    '  }',
    '  var srs = null;',
    '  if (t.srsId != null) {',
    '    var entry = meta && meta.srs ? (meta.srs[t.srsId] || null) : null;',
    '    var geo = isGeographicSrs(entry, t.srsId);',
    '    srs = { id: t.srsId, name: entry ? entry.name : null, org: entry ? entry.org : null, code: entry ? entry.code : null, geographic: geo, reprojected: reprojMethod || null };',
    '    var label = entry ? ((entry.org || "EPSG") + ":" + entry.code + " (" + entry.name + ")") : ("srs_id=" + t.srsId);',
    '    if (geo === false) {',
    '      warnings.push(reprojMethod',
    '        ? "座標系 " + label + " を WGS84(経緯度)へ再投影して表示します(" + reprojMethod + ")"',
    '        : "座標系 " + label + " は経緯度系ではなく再投影も解決できませんでした。表示位置がずれます");',
    '    } else if (t.srsId === -1 || t.srsId === 0) {',
    '      warnings.push("座標系が未定義です(" + label + ")");',
    '    }',
    '  }',
    '  if (meta && meta.tiles && meta.tiles.length) {',
    '    warnings.push("タイル行列セット " + meta.tiles.join(", ") + " を含みます(タイル描画は未対応)");',
    '  }',
    '  if (meta && meta.styles && ((meta.styles.list && meta.styles.list.length) || meta.styles.orphanStylesheets)) {',
    '    var parts = [];',
    '    if (meta.styles.list && meta.styles.list.length) {',
    '      var fmts = [];',
    '      var styleNames = [];',
    '      for (var i = 0; i < meta.styles.list.length; i++) {',
    '        var st = meta.styles.list[i];',
    '        styleNames.push(st.style || ("#" + st.id));',
    '        for (var k = 0; k < st.formats.length; k++) { if (fmts.indexOf(st.formats[k]) < 0) fmts.push(st.formats[k]); }',
    '      }',
    '      parts.push("スタイル " + styleNames.join(", ") + (fmts.length ? "(形式: " + fmts.join("/") + ")" : ""));',
    '    }',
    '    if (meta.styles.orphanStylesheets) parts.push("地物表未紐付けのスタイルシート " + meta.styles.orphanStylesheets + " 件");',
    '    warnings.push("Portrayal 拡張(gpkgext_styles)に" + parts.join("、") + "が登録されています(描画への適用はエンジン依存: MapLibre は GeoDataClass 紐付け時に mbstyle を自動適用)");',
    '  }',
    '  if (meta && meta.symbolCount) warnings.push("Portrayal 拡張のシンボル " + meta.symbolCount + " 件を含みます(画像適用は Portrayal 対応エンジンのみ)");',
    '  if (meta && meta.fontCount) warnings.push("Portrayal 拡張のフォント " + meta.fontCount + " 件を含みます(フォント適用は Portrayal 対応エンジンのみ)");',
    '  var names = [];',
    '  var exts = (meta && meta.extensions) || [];',
    '  for (var i = 0; i < exts.length; i++) {',
    '    if (exts[i].name !== "gpkg_rtree_index" && exts[i].name !== "gpkg_schema" && !/^gpkgext_(sty|sym|font|semantic)/.test(exts[i].name) && names.indexOf(exts[i].name) < 0) names.push(exts[i].name);',
    '  }',
    '  if (names.length) warnings.push("未対応の拡張が登録されています: " + names.join(", "));',
    '  return { warnings: warnings, srs: srs };',
    '}',
    '',
    'function readColumnMeta(db, tableName) {',
    '  try {',
    '    var res = db.exec("SELECT column_name, title, description FROM gpkg_data_columns WHERE table_name = " + quoteLit(tableName));',
    '    var vals = (res[0] && res[0].values) || [];',
    '    var out = {};',
    '    for (var i = 0; i < vals.length; i++) {',
    '      if (vals[i][1] || vals[i][2]) out[vals[i][0]] = { title: vals[i][1] || null, description: vals[i][2] || null };',
    '    }',
    '    return Object.keys(out).length ? out : null;',
    '  } catch (e) { return null; }',
    '}',
    '',
    'function readStyleInfo(db, tableName, styleName) {',
    '  try {',
    '    var sres = db.exec("SELECT styleName, styleQML, styleSLD FROM layer_styles WHERE f_table_name = " + quoteLit(tableName) + " ORDER BY useAsDefault DESC");',
    '    var rows = (sres[0] && sres[0].values) || [];',
    '    if (!rows.length) return null;',
    '    var styleNames = [];',
    '    for (var n = 0; n < rows.length; n++) {',
    '      if (typeof rows[n][0] === "string" && rows[n][0].trim()) styleNames.push(rows[n][0]);',
    '    }',
    '    var target = null, missing = null;',
    '    if (styleName) {',
    '      for (var k = 0; k < rows.length; k++) { if (rows[k][0] === styleName) { target = rows[k]; break; } }',
    '      if (!target) missing = styleName;',
    '    }',
    '    if (!target) {',
    '      for (var i = 0; i < rows.length; i++) {',
    '        if (typeof rows[i][1] === "string" && rows[i][1].trim()) { target = rows[i]; break; }',
    '      }',
    '      if (!target) target = rows[0];',
    '    }',
    '    var qml = (typeof target[1] === "string" && target[1].trim()) ? target[1] : null;',
    '    var sld = (typeof target[2] === "string" && target[2].trim()) ? target[2] : null;',
    '    return { qml: qml, sld: qml ? null : sld, sldOnly: !qml && !!sld,',
    '      styleName: (typeof target[0] === "string") ? target[0] : null,',
    '      styleNames: styleNames, missing: missing };',
    '  } catch (e) { return null; }',
    '}',
    '',
    'function buildFeatureSelect(o) {',
    '  var cols = Array.isArray(o.columns) && o.columns.length ? o.columns.map(quoteIdent) : null;',
    '  var selectCols = cols ? cols.concat([quoteIdent(o.geomCol)]).join(", ") : "*";',
    '  var predicates = [];',
    '  if (o.where) predicates.push("(" + o.where + ")");',
    '  var clauses = [];',
    '  if (predicates.length) clauses.push("WHERE " + predicates.join(" AND "));',
    '  if (Number.isInteger(o.limit) && o.limit > 0) clauses.push("LIMIT " + Math.floor(o.limit));',
    '  return "SELECT " + selectCols + " FROM " + quoteIdent(o.tableName) + " " + clauses.join(" ");',
    '}',
    '',
    'function cmdLoad(msg) {',
    '  return openDb(msg).then(function (db) {',
    '    return dbMetaFor(msg).then(function (meta) {',
    '      var t = resolveFeatureTable(db, msg.table, meta);',
    '      var xp = (t.srsId != null && t.srsId > 0) ? resolveTransform(msg.url, t.srsId, meta) : Promise.resolve(null);',
    '      return xp.then(function (xform) {',
    '        var tw = tableWarnings(meta, t, xform ? xform.method : null);',
    '        var warnings = tw.warnings;',
    '        var columnMeta = readColumnMeta(db, t.tableName);',
    '        var styleInfo = readStyleInfo(db, t.tableName, msg.styleName || null);',
    '        if (styleInfo && styleInfo.missing) {',
    '          warnings.push("layer_styles に styleName \\"" + styleInfo.missing + "\\" がありません(登録: " + (styleInfo.styleNames.join(", ") || "なし") + ")。既定スタイルを適用します");',
    '        }',
    '        if (!t.hasGeom) {',
    '          return { geojson: { type: "FeatureCollection", features: [] }, qml: null, total: 0,',
    '            count: 0, kind: "attributes", srs: tw.srs, extensions: meta.extensions, columnMeta: columnMeta,',
    '            styles: meta.styles || null,',
    '            warnings: freshWarnings(msg.url + "|" + t.tableName, warnings) };',
    '        }',
    '        var canFilter = msg.bbox && (xform || !tw.srs || tw.srs.geographic !== false);',
    '        var sql = buildFeatureSelect({ tableName: t.tableName, geomCol: t.geomCol, columns: msg.columns, where: msg.where, limit: msg.limit });',
    '        var stmt = db.prepare(sql);',
    '        var colNames = stmt.getColumnNames();',
    '        var features = [];',
    '        var dropped = 0;',
    '        while (stmt.step()) {',
    '          var row = stmt.get();',
    '          var rec = {};',
    '          colNames.forEach(function (c, i) { rec[c] = row[i]; });',
    '          if (canFilter && !envelopeIntersects(transformEnvelope(gpkgGeometryEnvelope(rec[t.geomCol]), xform && xform.fn), msg.bbox)) continue;',
    '          var wkb = gpkgGeometryToWkb(rec[t.geomCol]);',
    '          var geometry = wkb ? wkbToGeoJsonGeometry(wkb) : null;',
    '          if (!geometry) { dropped++; continue; }',
    '          if (xform) transformGeoJsonGeometry(geometry, xform.fn);',
    '          var properties = {};',
    '          for (var i = 0; i < colNames.length; i++) { var c = colNames[i]; if (c !== t.geomCol) properties[c] = sanitize(rec[c]); }',
    '          features.push({ type: "Feature", geometry: geometry, properties: properties });',
    '        }',
    '        stmt.free();',
    '        if (dropped) warnings.push(dropped + " 件の地物ジオメトリをデコードできませんでした(未対応のジオメトリ型)");',
    '        var total = null;',
    '        if (msg.bbox && msg.where) {',
    '          try {',
    '            var cres = db.exec("SELECT COUNT(*) AS n FROM " + quoteIdent(t.tableName) + " WHERE (" + msg.where + ")");',
    '            total = Number((cres[0] && cres[0].values && cres[0].values[0] && cres[0].values[0][0]) || 0);',
    '          } catch (e) {}',
    '        }',
    '        var qml = msg.wantStyle && styleInfo ? styleInfo.qml : null;',
    '        return { geojson: { type: "FeatureCollection", features: features }, qml: qml,',
    '          sld: msg.wantStyle && styleInfo ? styleInfo.sld : null,',
    '          styleName: styleInfo ? styleInfo.styleName : null,',
    '          styleNames: styleInfo ? styleInfo.styleNames : null,',
    '          total: total, count: features.length, kind: "features", srs: tw.srs,',
    '          extensions: meta.extensions, columnMeta: columnMeta, styles: meta.styles || null, dropped: dropped,',
    '          warnings: freshWarnings(msg.url + "|" + t.tableName, warnings) };',
    '      });',
    '    });',
    '  });',
    '}',
    '',
    'function cmdAttrs(msg) {',
    '  return openDb(msg).then(function (db) {',
    '    return dbMetaFor(msg).then(function (meta) {',
    '      var t = resolveFeatureTable(db, msg.table, meta);',
    '      var xp = (t.srsId != null && t.srsId > 0) ? resolveTransform(msg.url, t.srsId, meta) : Promise.resolve(null);',
    '      return xp.then(function (xform) {',
    '      var allCols = tableColumns(db, t.tableName);',
    '      var attrCols = (Array.isArray(msg.columns) && msg.columns.length)',
    '        ? msg.columns.filter(function (name) { return allCols.indexOf(name) >= 0; })',
    '        : allCols.filter(function (name) { return name !== t.geomCol; });',
    '      var predicates = [];',
    '      if (msg.where) predicates.push("(" + msg.where + ")");',
    '      var needle = String(msg.searchText || "").trim();',
    '      if (needle && attrCols.length) {',
    '        var escaped = needle.replace(/[\\\\%_]/g, function (m) { return "\\\\" + m; });',
    '        var lit = quoteLit("%" + escaped + "%");',
    '        predicates.push("(" + attrCols.map(function (name) { return "CAST(" + quoteIdent(name) + " AS TEXT) LIKE " + lit + " ESCAPE \'\\\\\'"; }).join(" OR ") + ")");',
    '      }',
    '      var where = predicates.length ? " WHERE " + predicates.join(" AND ") : "";',
    '      var geomExpr = t.hasGeom',
    '        ? (attrCols.length ? ", " + quoteIdent(t.geomCol) : quoteIdent(t.geomCol))',
    '        : "";',
    '      var stmt = db.prepare("SELECT " + (attrCols.map(quoteIdent).join(", ") || "*") + geomExpr + " FROM " + quoteIdent(t.tableName) + where);',
    '      var rows = [];',
    '      while (stmt.step()) {',
    '        var row = stmt.get();',
    '        var values = row.slice(0, attrCols.length).map(function (v) {',
    '          var sv = sanitize(v);',
    '          return sv == null ? "" : String(sv);',
    '        });',
    '        var geomValue = t.hasGeom ? row[attrCols.length] : null;',
    '        var env = t.hasGeom ? gpkgGeometryEnvelope(geomValue) : null;',
    '        var geometry = null;',
    '        if (t.hasGeom && (!env || msg.wantGeom)) {',
    '          var wkb = gpkgGeometryToWkb(geomValue);',
    '          geometry = wkb ? wkbToGeoJsonGeometry(wkb) : null;',
    '          if (geometry && xform) transformGeoJsonGeometry(geometry, xform.fn);',
    '          if (!env && geometry) env = geoJsonGeometryEnvelope(geometry);',
    '        }',
    '        if (env && xform) env = transformEnvelope(env, xform.fn);',
    '        var center = env ? { lat: (env.south + env.north) / 2, lng: (env.west + env.east) / 2 } : null;',
    '        rows.push({ values: values, lat: center ? center.lat : null, lng: center ? center.lng : null, geometry: geometry });',
    '      }',
    '      stmt.free();',
    '      var tw = tableWarnings(meta, t, xform ? xform.method : null);',
    '      return { attributes: attrCols, rows: rows, columnMeta: readColumnMeta(db, t.tableName),',
    '        warnings: freshWarnings(msg.url + "|" + t.tableName, tw.warnings) };',
    '      });',
    '    });',
    '  });',
    '}',
    '',
    'function u8ToBase64(u8) {',
    '  if (!u8) return null;',
    '  var bytes = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);',
    '  var s = "";',
    '  for (var i = 0; i < bytes.length; i += 0x8000) {',
    '    s += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(i, i + 0x8000)));',
    '  }',
    '  return btoa(s);',
    '}',
    'function blobToTextOrBase64(v) {',
    '  if (typeof v === "string") return { text: v, base64: null };',
    '  if (!v) return { text: null, base64: null };',
    '  var u8 = new Uint8Array(v);',
    '  try {',
    '    var t = new TextDecoder("utf-8", { fatal: true }).decode(u8);',
    '    return { text: t, base64: null };',
    '  } catch (e) { return { text: null, base64: u8ToBase64(u8) }; }',
    '}',
    '',
    // OGC 24-050 Portrayal 拡張の内容物と 24-049 semantic-annotations を返す。
    // module Worker の cmdStyle と同じ返却形式
    'function cmdStyle(msg) {',
    '  return openDb(msg).then(function (db) {',
    '    return dbMetaFor(msg).then(function (meta) {',
    '      var sheets = [];',
    '      try {',
    '        var res = db.exec("SELECT id, style_id, format, stylesheet FROM gpkgext_stylesheets");',
    '        var vals = (res[0] && res[0].values) || [];',
    '        for (var i = 0; i < vals.length; i++) {',
    '          var tb = blobToTextOrBase64(vals[i][3]);',
    '          sheets.push({ id: Number(vals[i][0]), styleId: Number(vals[i][1]), format: String(vals[i][2] || ""), data: tb.text, dataBase64: tb.base64 });',
    '        }',
    '      } catch (e) {}',
    '      var symbols = [];',
    '      try {',
    '        var sres = db.exec("SELECT s.id, s.symbol, s.title, s.description, s.uri, i.id, i.content_id, i.width, i.height, i.offset_x, i.offset_y, i.pixel_ratio, c.format, c.uri, c.content FROM gpkgext_symbols s LEFT JOIN gpkgext_symbol_images i ON i.symbol_id = s.id LEFT JOIN gpkgext_symbol_content c ON c.id = i.content_id");',
    '        var svals = (sres[0] && sres[0].values) || [];',
    '        var byId = {};',
    '        var order = [];',
    '        for (var j = 0; j < svals.length; j++) {',
    '          var v = svals[j];',
    '          var sid = Number(v[0]);',
    '          if (!byId[sid]) { byId[sid] = { id: sid, symbol: v[1], title: v[2] || null, description: v[3] || null, uri: v[4] || null, images: [] }; order.push(sid); }',
    '          if (v[5] != null) {',
    '            byId[sid].images.push({ id: Number(v[5]), contentId: Number(v[6]),',
    '              width: v[7] != null ? v[7] : null, height: v[8] != null ? v[8] : null,',
    '              offsetX: v[9] != null ? v[9] : null, offsetY: v[10] != null ? v[10] : null, pixelRatio: v[11] != null ? v[11] : null,',
    '              format: v[12] || null, uri: v[13] || null, dataBase64: u8ToBase64(v[14]) });',
    '          }',
    '        }',
    '        for (var m = 0; m < order.length; m++) symbols.push(byId[order[m]]);',
    '      } catch (e) {}',
    '      var fonts = [];',
    '      try {',
    '        var fres = db.exec("SELECT id, name, font, glyphs FROM gpkgext_fonts");',
    '        var fvals = (fres[0] && fres[0].values) || [];',
    '        for (var f = 0; f < fvals.length; f++) {',
    '          fonts.push({ id: Number(fvals[f][0]), name: fvals[f][1] || null, fontBase64: u8ToBase64(fvals[f][2]), glyphsBase64: u8ToBase64(fvals[f][3]) });',
    '        }',
    '      } catch (e) {}',
    '      var featureTables = Object.keys(meta.kinds || {}).filter(function (t) { return meta.kinds[t] === "features"; });',
    '      return { styles: meta.styles || null, sheets: sheets, symbols: symbols, fonts: fonts,',
    '        annotations: meta.annotations || {}, annotationRefs: meta.annotationRefs || [],',
    '        featureTables: featureTables };',
    '    });',
    '  });',
    '}',
    '',
    'var queue = Promise.resolve();',
    'self.onmessage = function (event) {',
    '  var msg = event.data || {};',
    '  var reqId = msg.reqId;',
    '  queue = queue.then(function () {',
    '    if (msg.cmd === "load") return cmdLoad(msg);',
    '    if (msg.cmd === "attrs") return cmdAttrs(msg);',
    '    if (msg.cmd === "style") return cmdStyle(msg);',
    '    if (msg.cmd === "warm") return loadSqlJs().then(function () { return {}; });',
    '    if (msg.cmd === "reset") {',
    '      dbs.forEach(function (p) { p.then(function (db) { try { db.close(); } catch (e) {} }, function () {}); });',
    '      dbs.clear(); metas.clear(); warned.clear(); transforms.clear();',
    '      return {};',
    '    }',
    '    return {};',
    '  }).then(function (result) {',
    '    var out = { reqId: reqId };',
    '    if (result) Object.keys(result).forEach(function (k) { out[k] = result[k]; });',
    '    self.postMessage(out);',
    '  }, function (error) {',
    '    self.postMessage({ reqId: reqId, error: error instanceof Error ? error.message : String(error) });',
    '  });',
    '};',
  ].join('\n');

  var gpkgWorker = null;
  var gpkgWorkerReqId = 0;
  var gpkgWorkerPending = new Map();
  function loadGpkgWorker() {
    if (!gpkgWorker) {
      var blob = new Blob([GPKG_WORKER_SRC], { type: 'text/javascript' });
      gpkgWorker = new Worker(URL.createObjectURL(blob));
      gpkgWorker.onmessage = function (event) {
        var data = event.data || {};
        var pending = gpkgWorkerPending.get(data.reqId);
        if (!pending) return;
        gpkgWorkerPending.delete(data.reqId);
        if (data.error) pending.reject(new Error(data.error));
        else pending.resolve(data);
      };
      gpkgWorker.onerror = function (event) {
        var error = new Error((event && event.message) || 'gpkg worker failed');
        gpkgWorkerPending.forEach(function (p) { p.reject(error); });
        gpkgWorkerPending.clear();
      };
    }
    return gpkgWorker;
  }
  function gpkgWorkerCall(cmd, params) {
    return new Promise(function (resolve, reject) {
      var reqId = ++gpkgWorkerReqId;
      gpkgWorkerPending.set(reqId, { resolve: resolve, reject: reject });
      loadGpkgWorker().postMessage(Object.assign({ cmd: cmd, reqId: reqId }, params || {}));
    });
  }

  function isGpkgBackedItem(item) {
    if (!item) return false;
    if (item.type === 'gpkg') return true;
    if (item.type === 'duckdb') {
      var format = String(item.format || '').toLowerCase();
      return format === 'gpkg' || /\.gpkg([?#]|$)/i.test(item.url || '');
    }
    return false;
  }
  KascLoader.isGpkgBackedItem = isGpkgBackedItem;

  function loadGeoPackageAsGeoJson(item) {
    var msg = {
      url: item.url || (item.file && item.file.name) || 'file',
      directUrl: item.directUrl || null,
      table: item.gpkgTable || null,
      where: item.where || null,
      limit: item.limit || null,
      columns: item.columns || null,
      bbox: item.bboxAuto ? item.bboxBounds : null,
      // 埋め込みスタイル(layer_styles QML/SLD)は style= 外部指定が無い場合に取得。
      // gpkgstyle= で任意スタイルを選択可(通常 gpkg: 経路と同規約)
      wantStyle: !item.style || !!item.gpkgstyle,
      styleName: item.gpkgstyle || null
    };
    var callP;
    if (item.file) {
      callP = item.file.arrayBuffer().then(function (buf) {
        return gpkgWorkerCall('load', Object.assign(msg, { buffer: buf, url: item.file.name }));
      });
    } else {
      callP = gpkgWorkerCall('load', msg);
    }
    return callP.then(function (res) {
      // Worker 側で重複排除済みの未対応警告(非経緯度CRS/拡張/タイル行列等)を console へ
      if (res && res.warnings && res.warnings.length) {
        console.warn('GPKG (' + (item.title || item.url || '') + '): ' + res.warnings.join(' / '));
      }
      // qml/sld/メタを呼び出し側(vector-load.js)が拾えるよう item へ保持する
      // (KascLoader.load の戻り値契約は FeatureCollection なのでサイドチャネル)
      item._gpkgLoadRes = res;
      return res.geojson;
    });
  }
  // 属性一覧・メタ問合せ等の attrs/load 拡張コマンドを呼べるよう公開する
  // (module Worker 版 gpkg-worker.js との機能パリティ)
  KascLoader.gpkgWorkerCall = gpkgWorkerCall;

  // ---------------------------------------------------------------
  // DuckDB-Wasm (CDN lazy load。kasugai app.js 移植)
  // ---------------------------------------------------------------
  var DUCKDB_WASM_VERSION = '1.32.0';
  var ddbPromise = null;
  function loadDuckDb() {
    if (!ddbPromise) {
      var loading = (function () {
        return import('https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + DUCKDB_WASM_VERSION + '/+esm').then(function (duckdb) {
          return duckdb.selectBundle(duckdb.getJsDelivrBundles()).then(function (bundle) {
            var workerUrl = URL.createObjectURL(new Blob(['importScripts(' + JSON.stringify(bundle.mainWorker) + ');'], { type: 'text/javascript' }));
            var worker = new Worker(workerUrl);
            var logger = duckdb.VoidLogger ? new duckdb.VoidLogger() : new duckdb.ConsoleLogger();
            var db = new duckdb.AsyncDuckDB(logger, worker);
            return db.instantiate(bundle.mainModule, bundle.pthreadWorker).then(function () {
              try { URL.revokeObjectURL(workerUrl); } catch (e) {}
              return db.connect();
            }).then(function (conn) {
              var st = { conn: conn, db: db, spatial: false };
              return conn.query('INSTALL httpfs; LOAD httpfs;').catch(function () {})
                .then(function () { return conn.query('INSTALL spatial; LOAD spatial;').then(function () { st.spatial = true; }).catch(function () {}); })
                .then(function () { return conn.query('INSTALL parquet; LOAD parquet;').catch(function () {}); })
                .then(function () { return st; });
            });
          });
        });
      })();
      loading.catch(function () { if (ddbPromise === loading) ddbPromise = null; });
      ddbPromise = loading;
    }
    return ddbPromise;
  }
  KascLoader.loadDuckDb = loadDuckDb;

  function describeDuckDbColumns(conn, selectSql) {
    return conn.query('DESCRIBE ' + selectSql).then(function (table) {
      return table.toArray().map(function (row) {
        var plain = typeof row.toJSON === 'function' ? row.toJSON() : Object.assign({}, row);
        return { name: String(plain.column_name), type: String(plain.column_type || '').toUpperCase() };
      });
    });
  }

  function resolveDuckDbGeometryColumn(columns, geomName) {
    if (geomName) {
      var col = columns.find(function (c) { return c.name === geomName; });
      if (!col) throw new Error('geom= column not found: ' + geomName);
      return col;
    }
    return columns.find(function (c) { return c.type.indexOf('GEOMETRY') >= 0 || c.type.indexOf('WKB') >= 0; })
      || columns.find(function (c) { return /^(geometry|geom|wkb|the_geom)$/i.test(c.name); })
      || columns.find(function (c) { return c.type === 'BLOB'; })
      || null;
  }

  function resolveDuckDbLonLat(columns, lonName, latName) {
    var find = function (explicit, re) {
      if (explicit) {
        if (!columns.some(function (c) { return c.name === explicit; })) throw new Error('column not found: ' + explicit);
        return explicit;
      }
      var c = columns.find(function (c) { return re.test(c.name); });
      return c ? c.name : null;
    };
    var lon = find(lonName, /^(lon|lng|longitude|x)$/i);
    var lat = find(latName, /^(lat|latitude|y)$/i);
    if ((lon || lat) && !(lon && lat)) throw new Error('lon/lat columns could not be resolved (specify lon= and lat=)');
    return lon && lat ? { lon: lon, lat: lat } : null;
  }

  function duckDbGeometryCastExpr(col) {
    var name = quoteSqlIdent(col.name);
    if (col.type.indexOf('GEOMETRY') >= 0) return name;
    if (col.type === 'BLOB' || col.type.indexOf('WKB') >= 0) return 'TRY(ST_GeomFromWKB(' + name + '))';
    return 'COALESCE(TRY(ST_GeomFromText(' + name + ')), TRY(ST_GeomFromGeoJSON(' + name + ')))';
  }

  function duckDbGeometryExpr(col, spatial) {
    if (!spatial) return quoteSqlIdent(col.name);
    return 'ST_AsWKB(' + duckDbGeometryCastExpr(col) + ')';
  }

  var DUCKDB_WORLD_ENVELOPE = 'ST_MakeEnvelope(-180, -90, 180, 90)';

  function boundsToEnvelopeSql(b) {
    if (!b || !b.ranges || !b.ranges.length) return null;
    var env = function (r) { return 'ST_MakeEnvelope(' + Number(r.west) + ',' + Number(b.south) + ',' + Number(r.east) + ',' + Number(b.north) + ')'; };
    return b.ranges.length === 1 ? env(b.ranges[0]) : 'ST_Union(' + env(b.ranges[0]) + ', ' + env(b.ranges[1]) + ')';
  }

  function duckDbCoveringPredicate(refs, bounds) {
    if (!bounds) return null;
    var lon = bounds.ranges.map(function (r) { return '(' + refs.xmax + ' >= ' + Number(r.west) + ' AND ' + refs.xmin + ' <= ' + Number(r.east) + ')'; }).join(' OR ');
    return '((' + lon + ') AND ' + refs.ymax + ' >= ' + bounds.south + ' AND ' + refs.ymin + ' <= ' + bounds.north + ')';
  }

  function detectDuckDbCoveringFromMetadata(conn, url) {
    return conn.query("SELECT key, value FROM parquet_kv_metadata(" + quoteSqlLiteral(url) + ") WHERE key = 'geo'").then(function (table) {
      var row = table.toArray()[0];
      if (!row) return null;
      var plain = typeof row.toJSON === 'function' ? row.toJSON() : row;
      var raw = plain.value;
      var text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
      var geo = JSON.parse(text);
      var covering = geo && geo.columns && geo.columns[geo.primary_column] && geo.columns[geo.primary_column].covering && geo.columns[geo.primary_column].covering.bbox;
      if (!covering) return null;
      var ref = function (p) { return Array.isArray(p) && p.length ? p.map(quoteSqlIdent).join('.') : null; };
      var refs = { xmin: ref(covering.xmin), xmax: ref(covering.xmax), ymin: ref(covering.ymin), ymax: ref(covering.ymax) };
      if (!refs.xmin || !refs.xmax || !refs.ymin || !refs.ymax) return null;
      var exclude = {};
      [covering.xmin, covering.xmax, covering.ymin, covering.ymax].forEach(function (p) { if (Array.isArray(p) && p[0]) exclude[p[0]] = 1; });
      return { refs: refs, exclude: exclude };
    }).catch(function () { return null; });
  }

  function resolveDuckDbCoveringColumns(conn, item, columns) {
    if (Array.isArray(item.covering) && item.covering.length === 4) {
      var c = item.covering;
      var ex = {};
      c.forEach(function (n) { ex[n] = 1; });
      return Promise.resolve({ refs: { xmin: quoteSqlIdent(c[0]), xmax: quoteSqlIdent(c[1]), ymin: quoteSqlIdent(c[2]), ymax: quoteSqlIdent(c[3]) }, exclude: ex });
    }
    var format = String(item.format || '').toLowerCase();
    var isParquet = format === 'parquet' || (!format && /\.parquet([?#]|$)/i.test(item.url || ''));
    var metaP = isParquet ? detectDuckDbCoveringFromMetadata(conn, item.url) : Promise.resolve(null);
    return metaP.then(function (detected) {
      if (detected) return detected;
      var find = function (n) { var c = columns.find(function (c) { return c.name.toLowerCase() === n; }); return c ? c.name : null; };
      if (['xmin', 'xmax', 'ymin', 'ymax'].every(function (n) { return find(n); })) {
        return { refs: { xmin: quoteSqlIdent(find('xmin')), xmax: quoteSqlIdent(find('xmax')), ymin: quoteSqlIdent(find('ymin')), ymax: quoteSqlIdent(find('ymax')) }, exclude: {} };
      }
      return null;
    });
  }

  function duckDbValueToGeometry(value) {
    if (value instanceof Uint8Array) return wkbToGeoJsonGeometry(value);
    if (value && typeof value === 'object' && typeof value.type === 'string' && ('coordinates' in value || 'geometries' in value)) return value;
    if (typeof value === 'string' && value.trim().charAt(0) === '{') {
      try { var g = JSON.parse(value); return g && typeof g.type === 'string' ? g : null; } catch (e) {}
    }
    return null;
  }

  function duckDbTableToGeoJson(table, lonlat) {
    var fields = table.schema.fields.map(function (f) { return f.name; });
    var geomKey = fields.indexOf('__geom__') >= 0 ? '__geom__' : null;
    var features = [];
    var rows = table.toArray();
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var geometry = geomKey ? duckDbValueToGeometry(row[geomKey]) : null;
      if (!geometry && lonlat) {
        var x = Number(row[lonlat.lon]), y = Number(row[lonlat.lat]);
        if (Number.isFinite(x) && Number.isFinite(y)) geometry = { type: 'Point', coordinates: [x, y] };
      }
      if (!geometry) continue;
      var properties = {};
      for (var j = 0; j < fields.length; j++) {
        if (fields[j] === geomKey) continue;
        properties[fields[j]] = sanitize(row[fields[j]]);
      }
      features.push({ type: 'Feature', geometry: geometry, properties: properties });
    }
    return { type: 'FeatureCollection', features: features };
  }

  // duckdb: のソース SQL 式(format= または拡張子から自動判別)
  // item.registeredName があれば registerFileBuffer 済みのローカルファイル名を指す
  function duckDbSourceSql(item) {
    var literal = quoteSqlLiteral(item.registeredName || item.url);
    var format = String(item.format || '').toLowerCase();
    return format === 'parquet' ? 'read_parquet(' + literal + ')'
      : (format === 'csv' || format === 'tsv') ? 'read_csv_auto(' + literal + ')'
      : (format === 'json' || format === 'geojson') ? 'read_json_auto(' + literal + ')'
      : format === 'read' ? 'ST_Read(' + literal + ')'
      : literal;
  }

  function loadDuckDbLayerAsGeoJson(item) {
    if (isGpkgBackedItem(item)) return loadGeoPackageAsGeoJson(item);
    return loadDuckDb().then(function (st) {
      var conn = st.conn, spatial = st.spatial;
      // ローカルファイルは DuckDB のインメモリ FS に登録して読む
      var registerP = Promise.resolve();
      if (item.file && !item.registeredName) {
        item.registeredName = 'kasc-file-' + item.id + '-' + item.file.name.replace(/[^\w.\-]/g, '_');
        registerP = item.file.arrayBuffer().then(function (buf) {
          return st.db.registerFileBuffer(item.registeredName, new Uint8Array(buf));
        });
      }
      return registerP.then(function () {
        var source = duckDbSourceSql(item);
        var ctx = {};
        return describeDuckDbColumns(conn, 'SELECT * FROM ' + source).then(function (columns) {
          ctx.columns = columns;
          var geomCol = resolveDuckDbGeometryColumn(columns, item.geom);
          var lonlat = geomCol ? null : resolveDuckDbLonLat(columns, item.lon, item.lat);
          if (!geomCol && !lonlat) throw new Error('geometry column not found (use geom= or lon=/lat=)');
          ctx.geomCol = geomCol;
          ctx.lonlat = lonlat;
          var envSql = boundsToEnvelopeSql(item.bboxAuto ? item.bboxBounds : null);
          return (envSql ? resolveDuckDbCoveringColumns(conn, item, columns) : Promise.resolve(null)).then(function (covering) {
            ctx.covering = covering;
            if (item.columns && item.columns.length) {
              var missing = item.columns.filter(function (n) { return !columns.some(function (c) { return c.name === n; }); });
              if (missing.length) throw new Error('columns= not found: ' + missing.join(', '));
            }
            var geomExpr = geomCol ? duckDbGeometryExpr(geomCol, spatial) + ' AS "__geom__"' : null;
            var excludeCols = [];
            if (geomCol) excludeCols.push(geomCol.name);
            if (covering) Object.keys(covering.exclude).forEach(function (n) { excludeCols.push(n); });
            var select = geomCol
              ? (item.columns && item.columns.length
                  ? 'SELECT ' + item.columns.map(quoteSqlIdent).join(', ') + ', ' + geomExpr
                  : 'SELECT * EXCLUDE (' + excludeCols.map(quoteSqlIdent).join(', ') + '), ' + geomExpr)
              : 'SELECT *';
            var preds = [];
            if (item.where) preds.push('(' + item.where + ')');
            if (envSql) {
              var coveringPred = covering ? duckDbCoveringPredicate(covering.refs, item.bboxBounds) : null;
              if (coveringPred) preds.push(coveringPred);
              var operand = geomCol
                ? (spatial ? duckDbGeometryCastExpr(geomCol) : null)
                : (spatial && lonlat ? 'ST_Point(' + quoteSqlIdent(lonlat.lon) + ', ' + quoteSqlIdent(lonlat.lat) + ')' : null);
              if (operand) preds.push('ST_Intersects(' + operand + ', ' + envSql + ')');
            }
            var sql = select + ' FROM ' + source;
            if (preds.length) sql += ' WHERE ' + preds.join(' AND ');
            if (item.limit) sql += ' LIMIT ' + Math.floor(item.limit);
            return conn.query(sql).then(function (table) { return duckDbTableToGeoJson(table, lonlat); });
          });
        });
      });
    });
  }

  function loadDuckDbQueryAsGeoJson(item) {
    return loadDuckDb().then(function (st) {
      var conn = st.conn, spatial = st.spatial;
      var query = String(item.query || '').replace(/;+\s*$/, '');
      if (/:bbox\b/i.test(query)) {
        if (!spatial) throw new Error('sql: :bbox placeholder requires the spatial extension');
        var envSql = boundsToEnvelopeSql(item.bboxBounds) || DUCKDB_WORLD_ENVELOPE;
        query = query.replace(/:bbox\b/gi, envSql);
      }
      return describeDuckDbColumns(conn, 'SELECT * FROM (' + query + ')').then(function (columns) {
        var geomCol = resolveDuckDbGeometryColumn(columns, null);
        var lonlat = geomCol ? null : resolveDuckDbLonLat(columns, null, null);
        if (!geomCol && !lonlat) throw new Error('query result has no geometry column (a geometry column or lon/lat columns are required)');
        var geomExpr = geomCol ? duckDbGeometryExpr(geomCol, spatial) + ' AS "__geom__"' : null;
        var sql = geomCol
          ? 'SELECT * EXCLUDE (' + quoteSqlIdent(geomCol.name) + '), ' + geomExpr + ' FROM (' + query + ')'
          : 'SELECT * FROM (' + query + ')';
        return conn.query(sql).then(function (table) { return duckDbTableToGeoJson(table, lonlat); });
      });
    });
  }

  // ---------------------------------------------------------------
  // CSV/TSV (簡易パーサ。lon/lat 列 → Point features)
  // ---------------------------------------------------------------
  function parseCsvText(text, delim) {
    var rows = [];
    var cur = [], field = '', inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === delim) { cur.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        cur.push(field); field = '';
        rows.push(cur); cur = [];
      } else field += ch;
    }
    if (field !== '' || cur.length) { cur.push(field); rows.push(cur); }
    return rows.filter(function (r) { return r.length && r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  function csvToGeoJson(text, name) {
    var firstLine = String(text || '').split(/\r?\n/)[0] || '';
    var delim = firstLine.indexOf('\t') >= 0 ? '\t' : (firstLine.indexOf(';') >= 0 && firstLine.indexOf(',') < 0 ? ';' : ',');
    var rows = parseCsvText(text, delim);
    if (!rows.length) throw new Error('empty csv');
    var headers = rows[0].map(function (h) { return String(h).trim(); });
    var findCol = function (re) { for (var i = 0; i < headers.length; i++) { if (re.test(headers[i])) return i; } return -1; };
    var lonIdx = findCol(/^(lon|lng|longitude|x|経度)$/i);
    var latIdx = findCol(/^(lat|latitude|y|緯度)$/i);
    if (lonIdx < 0 || latIdx < 0) throw new Error('lon/lat columns not found (use duckdb: line with format=csv for other layouts)');
    var features = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var x = Number(r[lonIdx]), y = Number(r[latIdx]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      var props = {};
      for (var j = 0; j < headers.length; j++) props[headers[j]] = r[j];
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: props });
    }
    return { type: 'FeatureCollection', features: features };
  }
  KascLoader.csvToGeoJson = csvToGeoJson;

  // ---------------------------------------------------------------
  // ogrsql: OGR SQL クエリ (shared/ogr-sql.js の動的 import)
  // このファイルは生成ビューアへインライン埋め込みされるため、
  // モジュールは配布一式内の既知パスから順に試す
  // ---------------------------------------------------------------
  var ogrSqlModulePromise = null;
  function loadOgrSqlModule() {
    if (!ogrSqlModulePromise) {
      var candidates = [
        'shared/ogr-sql.js', './shared/ogr-sql.js',
        '../shared/ogr-sql.js', '/shared/ogr-sql.js',
      ];
      ogrSqlModulePromise = (async function () {
        var lastErr = null;
        for (var i = 0; i < candidates.length; i++) {
          try { return await import(candidates[i]); } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('ogr-sql.js が見つかりません(配布一式に shared/ が含まれているか確認してください)');
      })();
      ogrSqlModulePromise.catch(function () { ogrSqlModulePromise = null; });
    }
    return ogrSqlModulePromise;
  }

  // 読み込み済みレイヤーのタイトル → FeatureCollection (ogrsql: の FROM 照合用)
  var ogrLoadedLayers = {};
  function ogrFileType(path) {
    var clean = String(path || '').split(/[?#]/)[0];
    if (/\.(fgb|flatgeobuf|fgbz|zst)$/i.test(clean)) return 'flatgeobuf';
    if (/\.(parquet|geoparquet)$/i.test(clean)) return 'geoparquet';
    if (/\.gpkg$/i.test(clean)) return 'gpkg';
    if (/\.tsv$/i.test(clean)) return 'csv';
    if (/\.csv$/i.test(clean)) return 'csv';
    return 'geojson';
  }
  function ogrDecodePath(path, table) {
    var it = { type: ogrFileType(path), title: table || path, url: path, visible: true };
    if (table) it.table = table;
    return KascLoader.load(it);
  }
  function loadOgrSql(item) {
    return loadOgrSqlModule().then(function (m) {
      var resolver = function (ref) {
        if (ref.source) return ogrDecodePath(ref.source, ref.name);
        var key = String(ref.name || '').trim().toLowerCase();
        var leaf = key.split('/').pop();
        if (ogrLoadedLayers[key]) return Promise.resolve(ogrLoadedLayers[key]);
        if (ogrLoadedLayers[leaf]) return Promise.resolve(ogrLoadedLayers[leaf]);
        var looksPath = /[/\]/.test(key) || /^[a-z][a-z0-9+.-]*:/i.test(key)
          || /\.(geojson|json|fgb|flatgeobuf|fgbz|zst|parquet|geoparquet|gpkg|csv|tsv)$/i.test(key);
        var candidates = looksPath ? [ref.name]
          : ['canvas_data/' + ref.name + '.geojson', 'canvas_data/' + ref.name + '.fgb',
             'canvas_data/' + ref.name + '.parquet', 'canvas_data/' + ref.name + '.gpkg',
             'canvas_data/' + ref.name + '.csv',
             'DATA/' + ref.name + '.geojson', 'DATA/' + ref.name + '.fgb',
             'DATA/' + ref.name + '.parquet', 'DATA/' + ref.name + '.gpkg',
             'DATA/' + ref.name + '.csv', ref.name];
        var lastErr = null;
        var tryNext = function (i) {
          if (i >= candidates.length) throw lastErr || new Error('ogrsql: テーブル "' + ref.name + '" を解決できません');
          return ogrDecodePath(candidates[i]).catch(function (e) { lastErr = e; return tryNext(i + 1); });
        };
        return tryNext(0);
      };
      return m.executeOgrSelect(item.query, resolver);
    });
  }

  // ---------------------------------------------------------------
  // 統合ローダー
  // ---------------------------------------------------------------
  // item.bboxBounds は呼び出し側が bbox=auto のクエリ範囲として設定する
  // ({ ranges:[{west,east}], south, north })
  KascLoader.load = function (item) {
    var inner;
    switch (item.type) {
      case 'geojson': inner = loadGeoJson(item); break;
      case 'flatgeobuf': inner = loadFlatGeobufAsGeoJson(item); break;
      case 'geoparquet': inner = loadGeoParquetAsGeoJson(item); break;
      case 'gpkg': inner = loadGeoPackageAsGeoJson(item); break;
      case 'duckdb': inner = loadDuckDbLayerAsGeoJson(item); break;
      case 'sql': inner = loadDuckDbQueryAsGeoJson(item); break;
      case 'csv': case 'tsv':
        inner = fetch(item.url, { mode: 'cors' }).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.text();
        }).then(function (t) { return csvToGeoJson(t, item.title); });
        break;
      case 'ogrsql': inner = loadOgrSql(item); break;
      default: return Promise.reject(new Error('unsupported type: ' + item.type));
    }
    return inner.then(function (geojson) {
      // ogrsql: の FROM 照合用に読み込み済みレイヤーをタイトルで登録する
      if (item && item.title && geojson) ogrLoadedLayers[String(item.title).trim().toLowerCase()] = geojson;
      return geojson;
    });
  };

  // ファイル入力用。File オブジェクトから type を判定して GeoJSON まで読む
  KascLoader.loadFile = function (file, hintType) {
    var type = hintType || KascLoader.detectType(file && file.name);
    if (type === 'kasc') return Promise.reject(new Error('kasc file must be handled by caller'));
    if (!type) return Promise.reject(new Error('unsupported file type: ' + (file && file.name)));
    if (type === 'geojson') {
      return file.text().then(function (t) {
        var g = JSON.parse(t);
        return { type: 'geojson', geojson: g };
      });
    }
    if (type === 'csv') {
      return file.text().then(function (t) {
        return { type: 'geojson', geojson: csvToGeoJson(t, file.name) };
      });
    }
    var item = { id: 'file-' + Date.now(), kind: 'vector', type: type, title: file.name, file: file, visible: true };
    return KascLoader.load(item).then(function (geojson) {
      return { type: type, geojson: geojson };
    });
  };

  // bbox=auto の対象か(duckdb:/gpkg:/geoparquet:。sql: は :bbox を含む場合。
  // geoparquet は covering/stats 無し・Range 非対応で全件へ落ちた
  // _gpRanged===false を除く)
  KascLoader.isViewportQueryLayer = function (item) {
    if (!item) return false;
    if ((item.type === 'duckdb' || item.type === 'gpkg') && item.bboxAuto) return true;
    if ((item.type === 'geoparquet' || item.type === 'parquet') && item.bboxAuto && item._gpRanged !== false) return true;
    if (item.type === 'sql' && /:bbox\b/i.test(item.query || '')) return true;
    return false;
  };
})();
