/*
 * kasc_panel.js — KASUGAI Canvas 形式のデータ取り込みパネル(共有UI)
 *
 * geo_webview が生成する MapLibre / OpenLayers ビューアに埋め込まれる。
 * kasc_loader.js (window.KascLoader) に依存する。
 *
 *   KascPanel.init({ engine: 'maplibre'|'openlayers', map, strings? })
 *
 * 右上に「取り込み」ボタンと折りたたみパネルを追加する。
 * - .kasc 設定行テキストを貼り付けて Apply でレイヤー追加
 * - ファイル選択でローカルファイルを取り込み
 *   (.geojson/.json/.fgb/.parquet/.gpkg/.csv/.tsv/.kasc)
 * - 追加済みレイヤーの表示/非表示・削除・範囲移動
 * - bbox=auto のクエリ系レイヤーは表示範囲の移動に追従して再クエリ
 */
(function () {
  'use strict';

  var KascPanel = {};
  window.KascPanel = KascPanel;

  var COLOR = '#3388ff';

  var DEFAULT_STRINGS = {
    button: 'Import',
    panelTitle: 'Data import (.kasc)',
    apply: 'Apply',
    addFiles: 'Add files',
    close: 'Close',
    layersTitle: 'Imported layers',
    hint: 'xyz:/base:/wms:/wmts:/geojson:/geoparquet:/flatgeobuf:/gpkg:/duckdb:/sql:',
    fileHint: 'Files: .geojson .json .fgb .parquet .gpkg .csv .tsv .kasc',
    empty: 'No imported layers',
    fit: 'Fit',
    remove: 'Remove',
    unsupported: 'Unsupported line skipped',
    loading: 'Loading...',
    errorPrefix: 'Error'
  };

  // ---------------------------------------------------------------
  // エンジンアダプタ
  // ---------------------------------------------------------------
  function makeMapLibreAdapter(map) {
    var seq = 0;
    var colorExpr = COLOR;
    // スタイル読み込み前の addSource/addLayer は失敗するため、
    // 未ロード時は isStyleLoaded() が true になるまでポーリングで遅延させる
    // ('load' イベントは一度しか発火しないため once('load') では取りこぼす)
    var ready = function (fn) {
      var poll = function (n) {
        var ok = false;
        try { ok = !map.isStyleLoaded || map.isStyleLoaded(); } catch (e) { ok = true; }
        if (ok) { try { fn(); } catch (e) { console.warn('[kasc] add failed', e); } return; }
        if (n > 0) setTimeout(function () { poll(n - 1); }, 200);
        else { try { fn(); } catch (e) { console.warn('[kasc] add failed', e); } }
      };
      poll(100); // 最大20秒待つ
    };
    var addVector = function (item, geojson) { ready(function () {
      var sid = 'kasc-src-' + (++seq) + '-' + item.id;
      map.addSource(sid, { type: 'geojson', data: geojson });
      var lids = [];
      var feats = (geojson && geojson.features) || [];
      var has = { point: false, line: false, poly: false };
      feats.forEach(function (f) {
        var t = f && f.geometry && f.geometry.type;
        if (!t) return;
        if (/Point/.test(t)) has.point = true;
        else if (/LineString/.test(t)) has.line = true;
        else has.poly = true;
      });
      if (has.poly) {
        var fid = sid + '-fill';
        map.addLayer({ id: fid, type: 'fill', source: sid, paint: { 'fill-color': colorExpr, 'fill-opacity': 0.3 }, filter: ['==', ['geometry-type'], 'Polygon'] });
        lids.push(fid);
        var oid = sid + '-outline';
        map.addLayer({ id: oid, type: 'line', source: sid, paint: { 'line-color': colorExpr, 'line-width': 1 }, filter: ['==', ['geometry-type'], 'Polygon'] });
        lids.push(oid);
      }
      if (has.line) {
        var lid = sid + '-line';
        map.addLayer({ id: lid, type: 'line', source: sid, paint: { 'line-color': colorExpr, 'line-width': 2 }, filter: ['==', ['geometry-type'], 'LineString'] });
        lids.push(lid);
      }
      if (has.point) {
        var pid = sid + '-point';
        map.addLayer({ id: pid, type: 'circle', source: sid, paint: { 'circle-radius': 5, 'circle-color': colorExpr, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 }, filter: ['==', ['geometry-type'], 'Point'] });
        lids.push(pid);
      }
      item._src = sid;
      item._lids = lids;
    }); };
    var addRaster = function (item) { ready(function () {
      var sid = 'kasc-src-' + (++seq) + '-' + item.id;
      // wms: は GetMap タイルテンプレート、wmts: は {z}/{x}/{y} へ正規化済みの tileUrl
      var tileUrl = item.type === 'wms' && window.KascLoader && window.KascLoader.wmsTileUrl
        ? window.KascLoader.wmsTileUrl(item.url, item.ogc || {}, '{bbox-epsg-3857}')
        : (item.type === 'wmts' && item.tileUrl ? item.tileUrl : item.url);
      var src = { type: 'raster', tiles: [tileUrl], tileSize: item.tileSize || 256 };
      if (item.attribution) src.attribution = item.attribution;
      map.addSource(sid, src);
      var lid = sid + '-raster';
      var layer = { id: lid, type: 'raster', source: sid, paint: { 'raster-opacity': item.opacity != null ? item.opacity : 0.8 } };
      if (item.minZoom != null) layer.minzoom = item.minZoom;
      if (item.maxZoom != null) layer.maxzoom = item.maxZoom;
      map.addLayer(layer);
      item._src = sid;
      item._lids = [lid];
    }); };
    var norm = function (d) { var lon = ((d + 180) % 360 + 360) % 360 - 180; return lon === -180 ? 180 : lon; };
    return {
      addVector: addVector,
      addRaster: addRaster,
      updateVector: function (item, geojson) {
        try { var s = map.getSource(item._src); if (s && s.setData) s.setData(geojson); } catch (e) {}
      },
      setVisible: function (item, visible) {
        (item._lids || []).forEach(function (lid) {
          try { map.setLayoutProperty(lid, 'visibility', visible ? 'visible' : 'none'); } catch (e) {}
        });
      },
      remove: function (item) {
        (item._lids || []).forEach(function (lid) { try { map.removeLayer(lid); } catch (e) {} });
        try { map.removeSource(item._src); } catch (e) {}
      },
      getViewBounds: function () {
        try {
          var b = map.getBounds();
          var west = norm(b.getWest()), east = norm(b.getEast());
          var south = Math.max(-89.9, Math.min(89.9, b.getSouth()));
          var north = Math.max(-89.9, Math.min(89.9, b.getNorth()));
          var ranges = west === east ? [{ west: -180, east: 180 }]
            : west < east ? [{ west: west, east: east }]
            : [{ west: west, east: 180 }, { west: -180, east: east }];
          return { ranges: ranges, south: south, north: north };
        } catch (e) { return null; }
      },
      onViewChange: function (cb) { map.on('moveend', cb); },
      fitBounds: function (env) {
        try { map.fitBounds([[env.west, env.south], [env.east, env.north]], { padding: 40, duration: 800 }); } catch (e) {}
      },
      isReady: function () { try { return !!(map && map.isStyleLoaded && map.isStyleLoaded()); } catch (e) { return true; } },
      onReady: function (cb) { try { map.once('load', cb); } catch (e) { cb(); } }
    };
  }

  function makeOpenLayersAdapter(map) {
    var seq = 0;
    var gjFormat = null;
    var toExtent4326 = function (env) {
      try { return ol.proj.transformExtent([env.west, env.south, env.east, env.north], 'EPSG:4326', map.getView().getProjection()); } catch (e) { return null; }
    };
    var defaultStyle = function () {
      return new ol.style.Style({
        image: new ol.style.Circle({ radius: 5, fill: new ol.style.Fill({ color: COLOR }), stroke: new ol.style.Stroke({ color: '#ffffff', width: 1.5 }) }),
        stroke: new ol.style.Stroke({ color: COLOR, width: 2 }),
        fill: new ol.style.Fill({ color: 'rgba(51,136,255,0.25)' })
      });
    };
    return {
      addVector: function (item, geojson) {
        if (!gjFormat) gjFormat = new ol.format.GeoJSON();
        var features = gjFormat.readFeatures(geojson, { dataProjection: 'EPSG:4326', featureProjection: map.getView().getProjection() });
        var source = new ol.source.Vector({ features: features });
        var layer = new ol.layer.Vector({ source: source, style: defaultStyle(), zIndex: 100 + (seq++) });
        map.addLayer(layer);
        item._layer = layer;
        item._source = source;
      },
      addRaster: function (item) {
        var src;
        var ext = item.bbox
          ? toExtent4326({ west: item.bbox[0], south: item.bbox[1], east: item.bbox[2], north: item.bbox[3] })
          : null;
        if (item.type === 'wms' && ol.source && ol.source.TileWMS) {
          var ogc = item.ogc || {};
          src = new ol.source.TileWMS({
            url: item.url,
            crossOrigin: 'anonymous',
            params: {
              LAYERS: ogc.layers || '',
              STYLES: ogc.styles || '',
              FORMAT: ogc.format || 'image/png',
              TRANSPARENT: !/^(false|0|off)$/i.test(String(ogc.transparent != null ? ogc.transparent : 'true')),
              VERSION: ogc.version || '1.1.1',
              TILED: true
            },
            attributions: item.attribution ? [item.attribution] : undefined,
            extent: ext || undefined
          });
        } else {
          var tileUrl = item.type === 'wmts' && item.tileUrl ? item.tileUrl : item.url;
          src = new ol.source.XYZ({
            url: tileUrl,
            attributions: item.attribution ? [item.attribution] : undefined,
            extent: ext || undefined
          });
        }
        var layer = new ol.layer.Tile({
          source: src,
          opacity: item.opacity != null ? item.opacity : 0.8,
          minZoom: item.minZoom != null ? item.minZoom : undefined,
          maxZoom: item.maxZoom != null ? item.maxZoom + 1 : undefined,
          zIndex: 50 + (seq++)
        });
        map.addLayer(layer);
        item._layer = layer;
      },
      updateVector: function (item, geojson) {
        try {
          if (!gjFormat) gjFormat = new ol.format.GeoJSON();
          var features = gjFormat.readFeatures(geojson, { dataProjection: 'EPSG:4326', featureProjection: map.getView().getProjection() });
          item._source.clear();
          item._source.addFeatures(features);
        } catch (e) {}
      },
      setVisible: function (item, visible) { try { item._layer.setVisible(visible); } catch (e) {} },
      remove: function (item) { try { map.removeLayer(item._layer); } catch (e) {} },
      getViewBounds: function () {
        try {
          var ext = map.getView().calculateExtent(map.getSize());
          var e4326 = ol.proj.transformExtent(ext, map.getView().getProjection(), 'EPSG:4326');
          var norm = function (d) { var lon = ((d + 180) % 360 + 360) % 360 - 180; return lon === -180 ? 180 : lon; };
          var west = norm(e4326[0]), east = norm(e4326[2]);
          var south = Math.max(-89.9, Math.min(89.9, e4326[1]));
          var north = Math.max(-89.9, Math.min(89.9, e4326[3]));
          var ranges = west === east ? [{ west: -180, east: 180 }]
            : west < east ? [{ west: west, east: east }]
            : [{ west: west, east: 180 }, { west: -180, east: east }];
          return { ranges: ranges, south: south, north: north };
        } catch (e) { return null; }
      },
      onViewChange: function (cb) { map.on('moveend', cb); },
      fitBounds: function (env) {
        var ext = toExtent4326(env);
        if (ext) { try { map.getView().fit(ext, { padding: [40, 40, 40, 40], duration: 600 }); } catch (e) {} }
      },
      isReady: function () { return true; },
      onReady: function (cb) { cb(); }
    };
  }

  // ---------------------------------------------------------------
  // パネル実体
  // ---------------------------------------------------------------
  KascPanel.init = function (opts) {
    if (!window.KascLoader) { console.warn('[kasc] KascLoader not loaded'); return null; }
    var map = opts.map;
    var engine = opts.engine;
    var S = Object.assign({}, DEFAULT_STRINGS, opts.strings || {});
    var adapter = engine === 'openlayers' ? makeOpenLayersAdapter(map) : makeMapLibreAdapter(map);
    var items = [];

    // ---- DOM ----
    var root = document.createElement('div');
    root.id = 'kasc-import-root';
    root.style.cssText = 'position:absolute;top:120px;right:10px;z-index:1005;font-family:sans-serif;font-size:13px;text-align:right;';
    if (opts.rootStyle) root.style.cssText = opts.rootStyle;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = S.button;
    btn.style.cssText = 'padding:6px 10px;background:#fff;border:1px solid #666;border-radius:4px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,0.2);';
    root.appendChild(btn);

    var panel = document.createElement('div');
    panel.style.cssText = 'display:none;margin-top:6px;width:320px;max-height:70vh;overflow:auto;background:#fff;border:1px solid #666;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.25);padding:8px;text-align:left;';
    panel.innerHTML =
      '<div style="font-weight:600;margin-bottom:6px;" data-kasc="title"></div>' +
      '<textarea data-kasc="text" spellcheck="false" style="width:100%;box-sizing:border-box;height:96px;font-family:monospace;font-size:11px;border:1px solid #ccc;border-radius:4px;"></textarea>' +
      '<div style="display:flex;gap:6px;margin-top:6px;">' +
      '  <button type="button" data-kasc="apply" style="flex:1;padding:5px;border:1px solid #4682b4;background:#4682b4;color:#fff;border-radius:4px;cursor:pointer;"></button>' +
      '  <button type="button" data-kasc="files" style="flex:1;padding:5px;border:1px solid #666;background:#fff;border-radius:4px;cursor:pointer;"></button>' +
      '  <button type="button" data-kasc="close" style="padding:5px 8px;border:1px solid #666;background:#fff;border-radius:4px;cursor:pointer;"></button>' +
      '</div>' +
      '<input type="file" data-kasc="fileinput" multiple style="display:none;" />' +
      '<div data-kasc="hint" style="color:#888;font-size:10px;margin-top:6px;line-height:1.4;"></div>' +
      '<div data-kasc="status" style="color:#666;font-size:11px;margin-top:4px;min-height:1.2em;"></div>' +
      '<div data-kasc="listtitle" style="font-weight:600;margin-top:8px;font-size:12px;"></div>' +
      '<div data-kasc="list"></div>';
    root.appendChild(panel);
    document.body.appendChild(root);

    var $ = function (k) { return panel.querySelector('[data-kasc="' + k + '"]'); };
    $('title').textContent = S.panelTitle;
    $('apply').textContent = S.apply;
    $('files').textContent = S.addFiles;
    $('close').textContent = S.close;
    $('hint').textContent = S.hint + ' / ' + S.fileHint;
    $('listtitle').textContent = S.layersTitle;
    $('text').placeholder = 'geojson: name | https://example.com/a.geojson\nxyz: name | https://.../{z}/{x}/{y}.png\ngpkg: name | https://example.com/a.gpkg | table=layer | where=pref=13';

    var status = function (text, isError) {
      var el = $('status');
      el.textContent = text || '';
      el.style.color = isError ? '#c0392b' : '#666';
    };

    btn.addEventListener('click', function () {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    $('close').addEventListener('click', function () { panel.style.display = 'none'; });

    // ---- レイヤー一覧 ----
    var renderList = function () {
      var list = $('list');
      list.innerHTML = '';
      if (!items.length) {
        var empty = document.createElement('div');
        empty.style.cssText = 'color:#999;font-size:11px;padding:4px 0;';
        empty.textContent = S.empty;
        list.appendChild(empty);
        return;
      }
      items.forEach(function (item) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:4px;padding:3px 0;border-bottom:1px solid #eee;font-size:12px;';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = item.visible !== false;
        cb.addEventListener('change', function () {
          item.visible = cb.checked;
          adapter.setVisible(item, cb.checked);
        });
        var name = document.createElement('span');
        name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        name.textContent = item.title;
        name.title = item.sourceLine || item.title;
        var badge = document.createElement('span');
        badge.style.cssText = 'color:#999;font-size:10px;flex:0 0 auto;';
        badge.textContent = item.type || '';
        var fitB = document.createElement('button');
        fitB.type = 'button';
        fitB.textContent = S.fit;
        fitB.style.cssText = 'font-size:10px;padding:2px 4px;border:1px solid #ccc;background:#fff;border-radius:3px;cursor:pointer;';
        fitB.addEventListener('click', function () {
          var env = item._env || (item._geojson && window.KascLoader.fcEnvelope(item._geojson));
          if (env) adapter.fitBounds(env);
        });
        var delB = document.createElement('button');
        delB.type = 'button';
        delB.textContent = '×';
        delB.title = S.remove;
        delB.style.cssText = 'font-size:12px;padding:0 5px;border:1px solid #ccc;background:#fff;border-radius:3px;cursor:pointer;';
        delB.addEventListener('click', function () {
          adapter.remove(item);
          var i = items.indexOf(item);
          if (i >= 0) items.splice(i, 1);
          renderList();
        });
        row.appendChild(cb); row.appendChild(name); row.appendChild(badge);
        row.appendChild(fitB); row.appendChild(delB);
        list.appendChild(row);
      });
    };
    renderList();

    // ---- レイヤー適用 ----
    var applyItem = function (item) {
      if (item.kind === 'unsupported') {
        status(S.unsupported + ': ' + (item.sourceLine || item.title), true);
        return;
      }
      if (item.kind === 'raster') {
        try {
          adapter.addRaster(item);
          if (item.visible === false) adapter.setVisible(item, false);
          items.push(item);
        } catch (e) {
          status(S.errorPrefix + ': ' + (e && e.message || e), true);
        }
        renderList();
        return;
      }
      // vector
      item.bboxBounds = adapter.getViewBounds();
      item._loading = true;
      renderList();
      window.KascLoader.load(item).then(function (geojson) {
        item._loading = false;
        item._geojson = geojson;
        item._env = window.KascLoader.fcEnvelope(geojson);
        try {
          adapter.addVector(item, geojson);
          if (item.visible === false) adapter.setVisible(item, false);
          items.push(item);
          status(item.title + ': ' + ((geojson && geojson.features) || []).length + ' features');
        } catch (e) {
          status(S.errorPrefix + ': ' + (e && e.message || e), true);
        }
        renderList();
      }).catch(function (e) {
        item._loading = false;
        status(S.errorPrefix + ': ' + item.title + ' - ' + (e && e.message || e), true);
        renderList();
      });
    };

    $('apply').addEventListener('click', function () {
      var parsed = window.KascLoader.parseLines($('text').value);
      var n = 0;
      parsed.items.forEach(function (item) {
        // 同一行の重複追加を防ぐ
        if (items.some(function (x) { return x.sourceLine === item.sourceLine && x.url === item.url; })) return;
        applyItem(item);
        n++;
      });
      if (parsed.skipped.length) {
        status(parsed.skipped.length + ' line(s) skipped: ' + (parsed.skipped[0].reason || ''), parsed.skipped.some(function (s) { return s.reason && s.reason.indexOf('required') >= 0; }));
      } else if (!n) {
        status(S.empty);
      }
    });

    // ---- ファイル取り込み ----
    $('files').addEventListener('click', function () { $('fileinput').click(); });
    $('fileinput').addEventListener('change', function (ev) {
      var files = Array.prototype.slice.call(ev.target.files || []);
      ev.target.value = '';
      files.forEach(function (file) {
        var type = window.KascLoader.detectType(file.name);
        if (type === 'kasc') {
          file.text().then(function (text) {
            var ta = $('text');
            ta.value = ta.value ? (ta.value + '\n' + text) : text;
          }).catch(function () {});
          return;
        }
        status(S.loading + ' ' + file.name);
        window.KascLoader.loadFile(file).then(function (r) {
          var item = {
            id: 'kasc-file-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
            kind: 'vector', type: r.type === 'geojson' ? 'geojson' : r.type,
            title: file.name, visible: true,
            sourceLine: 'file: ' + file.name
          };
          item._geojson = r.geojson;
          item._env = window.KascLoader.fcEnvelope(r.geojson);
          try {
            adapter.addVector(item, r.geojson);
            items.push(item);
            status(file.name + ': ' + ((r.geojson && r.geojson.features) || []).length + ' features');
          } catch (e) {
            status(S.errorPrefix + ': ' + (e && e.message || e), true);
          }
          renderList();
        }).catch(function (e) {
          status(S.errorPrefix + ': ' + file.name + ' - ' + (e && e.message || e), true);
        });
      });
    });

    // ---- bbox=auto 再クエリ(表示範囲連動) ----
    var moveTimer = null;
    adapter.onViewChange(function () {
      var targets = items.filter(function (it) { return window.KascLoader.isViewportQueryLayer(it) && it.visible !== false; });
      if (!targets.length) return;
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(function () {
        var bounds = adapter.getViewBounds();
        targets.forEach(function (item) {
          item.bboxBounds = bounds;
          window.KascLoader.load(item).then(function (geojson) {
            item._geojson = geojson;
            adapter.updateVector(item, geojson);
          }).catch(function (e) {
            console.warn('[kasc] viewport requery failed:', item.title, e);
          });
        });
      }, 600);
    });

    return { adapter: adapter, items: items, panel: panel };
  };
})();
