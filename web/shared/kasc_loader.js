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
 *   geoparquet:/parquet:  GeoParquet (hyparquet)
 *   flatgeobuf:/fgb:   FlatGeobuf (公式 JS リーダー)
 *   gpkg:/geopackage:  GeoPackage (sql.js Worker。table=/where=/limit=/columns=/bbox=auto)
 *   duckdb:            DuckDB-Wasm SQL 絞り込み (where=/limit=/geom=/lon=/lat=/format=/columns=/covering=/bbox=auto/table=)
 *   sql:               任意 SELECT 文 (:bbox プレースホルダ対応)
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
      if (!hasZ && !hasM && raw >= 1000) {
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
      switch (base) {
        case 1: return { type: 'Point', coordinates: point() };
        case 2: return { type: 'LineString', coordinates: points() };
        case 3: return { type: 'Polygon', coordinates: rings() };
        case 4: return { type: 'MultiPoint', coordinates: children().map(function (g) { return g && g.coordinates; }) };
        case 5: return { type: 'MultiLineString', coordinates: children().map(function (g) { return g && g.coordinates; }) };
        case 6: return { type: 'MultiPolygon', coordinates: children().map(function (g) { return g && g.coordinates; }) };
        case 7: return { type: 'GeometryCollection', geometries: children().filter(Boolean) };
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
    geojson: 1, layer: 1,
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

      // ---- sql: 任意クエリ ----
      if (type === 'sql') {
        var firstSep = value.indexOf('|');
        var stitle = firstSep < 0 ? '' : value.slice(0, firstSep).trim();
        var query = firstSep < 0 ? '' : value.slice(firstSep + 1).trim();
        var svisible = true;
        var tailRe = /\|\s*(off|false|attr(?:ibution)?\s*=[^|]*)\s*$/i;
        var tail;
        while ((tail = tailRe.exec(query))) {
          var seg = tail[1].trim();
          var attrM = /^attr(?:ibution)?\s*=\s*(.*)$/i.exec(seg);
          if (attrM) { /* 出典は現在未使用 */ }
          else if (/^(off|false)$/i.test(seg)) svisible = false;
          else break;
          query = query.slice(0, tail.index).trim();
        }
        if (!stitle || !query) { skipped.push({ line: line, reason: 'sql: title|query required' }); return; }
        items.push({ id: id, kind: 'vector', type: 'sql', title: stitle, query: query, visible: svisible, sourceLine: line });
        return;
      }

      // ---- ベクター系 (geojson/geoparquet/flatgeobuf/gpkg/duckdb) ----
      if (LAYER_LINE_TYPES[type]) {
        var vparts = value.split('|').map(function (p) { return p.trim(); });
        var vtitle = vparts[0];
        var vurl = vparts[1];
        var vvisible = !vparts.some(function (p) { return /^(off|false)$/i.test(p); });
        if (!vtitle) { skipped.push({ line: line, reason: 'title required' }); return; }
        var vtype = type === 'layer' ? 'geojson' : (type === 'parquet' ? 'geoparquet' : (type === 'fgb' ? 'flatgeobuf' : (type === 'geopackage' ? 'gpkg' : type)));
        var item = {
          id: id, kind: 'vector', type: vtype, title: vtitle, url: vurl || '',
          visible: vvisible, attribution: parseAttributionField(vparts[2]), sourceLine: line
        };
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
        });
        if (vtype === 'gpkg' || vtype === 'duckdb') {
          if (item.bboxAuto === undefined) item.bboxAuto = true;
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
    if (/\.geojson$|\.json$/.test(n)) return 'geojson';
    if (/\.fgb$|\.flatgeobuf$/.test(n)) return 'flatgeobuf';
    if (/\.parquet$|\.geoparquet$/.test(n)) return 'geoparquet';
    if (/\.gpkg$|\.geopackage$/.test(n)) return 'gpkg';
    if (/\.csv$|\.tsv$/.test(n)) return 'csv';
    if (/\.kasc$|\.txt$/.test(n)) return 'kasc';
    return null;
  };

  // ---------------------------------------------------------------
  // GeoJSON
  // ---------------------------------------------------------------
  function loadGeoJson(item) {
    if (item.data) return Promise.resolve(item.data);
    return fetch(item.url, { mode: 'cors' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  // ---------------------------------------------------------------
  // FlatGeobuf (CDN lazy import)
  // ---------------------------------------------------------------
  var fgbPromise = null;
  function loadFlatGeobufModule() {
    if (!fgbPromise) {
      fgbPromise = import('https://cdn.jsdelivr.net/npm/flatgeobuf@4.6.1/lib/mjs/geojson.js/+esm');
      fgbPromise.catch(function () { fgbPromise = null; });
    }
    return fgbPromise;
  }
  function loadFlatGeobufAsGeoJson(item) {
    return loadFlatGeobufModule().then(function (mod) {
      var streamPromise;
      if (item.file) {
        streamPromise = Promise.resolve(item.file.stream ? item.file.stream() : null);
      } else {
        streamPromise = fetch(item.url, { mode: 'cors' }).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.body;
        });
      }
      return streamPromise.then(function (body) {
        if (!body) throw new Error('empty response body');
        var features = [];
        var iter = mod.deserialize(body);
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
      });
    });
  }

  // ---------------------------------------------------------------
  // GeoParquet (hyparquet CDN lazy import)
  // ---------------------------------------------------------------
  var pqPromise = null;
  function loadHyparquet() {
    if (!pqPromise) {
      pqPromise = Promise.all([
        import('https://cdn.jsdelivr.net/npm/hyparquet@1.31.5/+esm'),
        import('https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.2/+esm')
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
  function loadGeoParquetAsGeoJson(item) {
    return loadHyparquet().then(function (mod) {
      var fileP;
      if (item.file) {
        fileP = item.file.arrayBuffer();
      } else {
        try { fileP = mod.asyncBufferFromUrl({ url: item.url }); } catch (e) { fileP = Promise.reject(e); }
        fileP = fileP.catch(function () {
          return fetch(item.url, { mode: 'cors' }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.arrayBuffer();
          });
        });
      }
      return fileP.then(function (file) {
        return Promise.all([
          mod.parquetReadObjects({ file: file, compressors: mod.compressors }),
          Promise.resolve(mod.parquetMetadata ? mod.parquetMetadata(file) : null).catch(function () { return null; })
        ]).then(function (r) { return { rows: r[0] || [], meta: r[1] }; });
      }).then(function (r0) {
        var rows = r0.rows;
        if (!rows.length) return { type: 'FeatureCollection', features: [] };
        var geomColumn = null;
        try {
          var kv = r0.meta && (r0.meta.key_value_metadata || r0.meta.metadata || []);
          var entry = Array.isArray(kv) ? kv.find(function (it) { return it && it.key === 'geo'; }) : (kv instanceof Map ? { value: kv.get('geo') } : null);
          var rawGeo = entry && entry.value;
          var geoText = rawGeo instanceof Uint8Array ? new TextDecoder().decode(rawGeo) : rawGeo;
          var geo = geoText ? JSON.parse(geoText) : null;
          if (geo && geo.primary_column) geomColumn = geo.primary_column;
        } catch (e) {}
        var isGeom = function (v) {
          return v instanceof Uint8Array || (v && typeof v === 'object' && typeof v.type === 'string' && ('coordinates' in v || 'geometries' in v));
        };
        var firstRow = rows[0];
        if (!geomColumn || !(geomColumn in firstRow)) {
          geomColumn = ('geometry' in firstRow) ? 'geometry' : Object.keys(firstRow).find(function (k) { return isGeom(firstRow[k]); });
        }
        if (!geomColumn) throw new Error('geometry column not found');
        var features = [];
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var value = row[geomColumn];
          var geometry = value instanceof Uint8Array ? wkbToGeoJsonGeometry(value) : (isGeom(value) ? value : null);
          if (!geometry) continue;
          var properties = {};
          var keys = Object.keys(row);
          for (var j = 0; j < keys.length; j++) { if (keys[j] !== geomColumn) properties[keys[j]] = sanitize(row[keys[j]]); }
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
    'var SQL_JS_VERSION = "1.15.1";',
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
    'var quoteIdent = function (n) { return "\\"" + String(n).replace(/"/g, "\\"\\"") + "\\""; };',
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
    '    if (!hasZ && !hasM && raw >= 1000) {',
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
    '    switch (base) {',
    '      case 1: return { type: "Point", coordinates: point() };',
    '      case 2: return { type: "LineString", coordinates: points() };',
    '      case 3: return { type: "Polygon", coordinates: rings() };',
    '      case 4: return { type: "MultiPoint", coordinates: children().map(function (g) { return g && g.coordinates; }) };',
    '      case 5: return { type: "MultiLineString", coordinates: children().map(function (g) { return g && g.coordinates; }) };',
    '      case 6: return { type: "MultiPolygon", coordinates: children().map(function (g) { return g && g.coordinates; }) };',
    '      case 7: return { type: "GeometryCollection", geometries: children().filter(Boolean) };',
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
    'function envelopeIntersects(env, bbox) {',
    '  if (!env || !bbox) return true;',
    '  var south = Number(bbox.south), north = Number(bbox.north);',
    '  if (!(env.north >= south && env.south <= north)) return false;',
    '  return bbox.ranges.some(function (r) { return env.east >= Number(r.west) && env.west <= Number(r.east); });',
    '}',
    '',
    'var dbs = new Map();',
    'function openDb(msg) {',
    '  var key = msg.url || ("buffer:" + (msg.reqId || 0) + ":" + Math.random());',
    '  if (msg.buffer) key = "buffer:" + msg.url;',
    '  var promise = dbs.get(key);',
    '  if (!promise) {',
    '    promise = loadSqlJs().then(function (SQL) {',
    '      if (msg.buffer) return new SQL.Database(new Uint8Array(msg.buffer));',
    '      return fetch(msg.url).then(function (res) {',
    '        if (!res.ok) throw new Error("HTTP " + res.status);',
    '        return res.arrayBuffer();',
    '      }).then(function (buf) { return new SQL.Database(new Uint8Array(buf)); });',
    '    });',
    '    promise.catch(function () { if (dbs.get(key) === promise) dbs.delete(key); });',
    '    dbs.set(key, promise);',
    '  }',
    '  return promise;',
    '}',
    '',
    'function resolveFeatureTable(db, table) {',
    '  var tableName = table || null;',
    '  if (!tableName) {',
    '    var res = db.exec("SELECT table_name FROM gpkg_geometry_columns ORDER BY rowid LIMIT 1");',
    '    tableName = res[0] && res[0].values && res[0].values[0] && res[0].values[0][0] || null;',
    '  }',
    '  if (!tableName) throw new Error("feature table not found");',
    '  var gres = db.exec("SELECT column_name FROM gpkg_geometry_columns WHERE table_name = " + quoteLit(tableName) + " LIMIT 1");',
    '  return { tableName: tableName, geomCol: (gres[0] && gres[0].values && gres[0].values[0] && gres[0].values[0][0]) || "geom" };',
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
    '    var t = resolveFeatureTable(db, msg.table);',
    '    var sql = buildFeatureSelect({ tableName: t.tableName, geomCol: t.geomCol, columns: msg.columns, where: msg.where, limit: msg.limit });',
    '    var stmt = db.prepare(sql);',
    '    var colNames = stmt.getColumnNames();',
    '    var features = [];',
    '    while (stmt.step()) {',
    '      var row = stmt.get();',
    '      var rec = {};',
    '      colNames.forEach(function (c, i) { rec[c] = row[i]; });',
    '      if (msg.bbox && !envelopeIntersects(gpkgGeometryEnvelope(rec[t.geomCol]), msg.bbox)) continue;',
    '      var wkb = gpkgGeometryToWkb(rec[t.geomCol]);',
    '      var geometry = wkb ? wkbToGeoJsonGeometry(wkb) : null;',
    '      if (!geometry) continue;',
    '      var properties = {};',
    '      for (var i = 0; i < colNames.length; i++) { var c = colNames[i]; if (c !== t.geomCol) properties[c] = sanitize(rec[c]); }',
    '      features.push({ type: "Feature", geometry: geometry, properties: properties });',
    '    }',
    '    stmt.free();',
    '    var qml = null;',
    '    if (msg.wantStyle) {',
    '      try {',
    '        var sres = db.exec("SELECT styleQML FROM layer_styles WHERE f_table_name = " + quoteLit(t.tableName) + " ORDER BY useAsDefault DESC");',
    '        var v = sres[0] && sres[0].values && sres[0].values[0] && sres[0].values[0][0];',
    '        if (typeof v === "string" && v.trim()) qml = v;',
    '      } catch (e) {}',
    '    }',
    '    return { geojson: { type: "FeatureCollection", features: features }, qml: qml, count: features.length };',
    '  });',
    '}',
    '',
    'var queue = Promise.resolve();',
    'self.onmessage = function (event) {',
    '  var msg = event.data || {};',
    '  var reqId = msg.reqId;',
    '  queue = queue.then(function () {',
    '    if (msg.cmd === "load") return cmdLoad(msg);',
    '    if (msg.cmd === "reset") { dbs.clear(); return {}; }',
    '    return {};',
    '  }).then(function (result) {',
    '    var out = { reqId: reqId };',
    '    if (result) Object.keys(result).forEach(function (k) { out[k] = result[k]; });',
    '    self.postMessage(out);',
    '  }, function (error) {',
    '    self.postMessage({ reqId: reqId, error: error instanceof Error ? error.message : String(error) });',
    '  });',
    '};'
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
      table: item.gpkgTable || null,
      where: item.where || null,
      limit: item.limit || null,
      columns: item.columns || null,
      bbox: item.bboxAuto ? item.bboxBounds : null,
      wantStyle: false
    };
    var callP;
    if (item.file) {
      callP = item.file.arrayBuffer().then(function (buf) {
        return gpkgWorkerCall('load', Object.assign(msg, { buffer: buf, url: item.file.name }));
      });
    } else {
      callP = gpkgWorkerCall('load', msg);
    }
    return callP.then(function (res) { return res.geojson; });
  }

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
  // 統合ローダー
  // ---------------------------------------------------------------
  // item.bboxBounds は呼び出し側が bbox=auto のクエリ範囲として設定する
  // ({ ranges:[{west,east}], south, north })
  KascLoader.load = function (item) {
    switch (item.type) {
      case 'geojson': return loadGeoJson(item);
      case 'flatgeobuf': return loadFlatGeobufAsGeoJson(item);
      case 'geoparquet': return loadGeoParquetAsGeoJson(item);
      case 'gpkg': return loadGeoPackageAsGeoJson(item);
      case 'duckdb': return loadDuckDbLayerAsGeoJson(item);
      case 'sql': return loadDuckDbQueryAsGeoJson(item);
      default: return Promise.reject(new Error('unsupported type: ' + item.type));
    }
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

  // bbox=auto の対象か(duckdb:/gpkg:。sql: は :bbox を含む場合)
  KascLoader.isViewportQueryLayer = function (item) {
    if (!item) return false;
    if ((item.type === 'duckdb' || item.type === 'gpkg') && item.bboxAuto) return true;
    if (item.type === 'sql' && /:bbox\b/i.test(item.query || '')) return true;
    return false;
  };
})();
