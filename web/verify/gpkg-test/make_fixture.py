# -*- coding: utf-8 -*-
# web/verify/gpkg-test/gpkg-test.gpkg を生成する。
# OGC GeoPackage 1.4.0 準拠の最小構成 + layer_styles(QGIS 埋め込み QML)
# + 非空間 attributes 表 + rtree 空間索引を含む検証フィクスチャ。
# 使い方: python web/verify/gpkg-test/make_fixture.py
import sqlite3, struct, os, sys, zlib, zipfile, io

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "gpkg-test.gpkg")


def gpkg_binary(srs_id, wkb, envelope=None):
    """GPkgBinary: 'GP' + ver + flags + srs_id(LE) + envelope + WKB"""
    if envelope:
        # flags: bit0 endian=little(1), bits1-3 envelope type XY(1<<1=2) -> 0b011
        flags = 0x03
        env = struct.pack("<4d", *envelope)
    else:
        flags = 0x01
        env = b""
    return b"GP" + bytes([0, flags]) + struct.pack("<I", srs_id) + env + wkb


def wkb_point(x, y):
    return struct.pack("<BI2d", 1, 1, x, y)


def wkb_linestring(pts):
    return struct.pack("<BII", 1, 2, len(pts)) + b"".join(struct.pack("<2d", x, y) for x, y in pts)


def wkb_polygon(rings):
    out = struct.pack("<BII", 1, 3, len(rings))
    for ring in rings:
        out += struct.pack("<I", len(ring)) + b"".join(struct.pack("<2d", x, y) for x, y in ring)
    return out


def wkb_circularstring(pts):
    """CircularString (type 8): 奇数個の制御点"""
    return struct.pack("<BII", 1, 8, len(pts)) + b"".join(struct.pack("<2d", x, y) for x, y in pts)


def wkb_triangle(rings):
    """Triangle (type 17): 構造は Polygon と同型"""
    return struct.pack("<BII", 1, 17, len(rings)) + b"".join(
        struct.pack("<I", len(r)) + b"".join(struct.pack("<2d", x, y) for x, y in r) for r in rings
    )


def envelope_of(coords):
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    return (min(xs), max(xs), min(ys), max(ys))


def make_png(w, h, rgba):
    # 最小構成の実 PNG(単色 RGBA)。シンボル画像の addImage 検証用
    def chunk(typ, data):
        c = typ + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))
    raw = b"".join(b"\x00" + rgba * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def make_zip(files):
    # {name: bytes} → zip。gpkgext_fonts.glyphs(Mapbox glyphs 集)検証用
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for n, d in files.items():
            z.writestr(n, d)
    return buf.getvalue()


# カテゴリ分類レンダラ(cat 列: high/low) — legend >=2 で kasugaiApi 経由の検出が可能
QML = """<qgis version="3.28" styleCategories="Symbology"><renderer-v2 type="categorizedSymbol" attr="cat" forceraster="0" enableorderby="0" referencescale="-1" symbollevels="0"><categories><category symbol="0" value="high" label="高" type="string" render="true"/><category symbol="1" value="low" label="低" type="string" render="true"/></categories><symbols><symbol type="marker" name="0" alpha="1" force_rhr="0" clip_to_extent="1" frame_rate="10" is_animated="0"><layer class="SimpleMarker" enabled="1" pass="0" locked="0"><Option type="Map"><Option name="color" value="230,30,30,255" type="QString"/><Option name="size" value="5" type="QString"/><Option name="name" value="circle" type="QString"/></Option></layer></symbol><symbol type="marker" name="1" alpha="1" force_rhr="0" clip_to_extent="1" frame_rate="10" is_animated="0"><layer class="SimpleMarker" enabled="1" pass="0" locked="0"><Option type="Map"><Option name="color" value="30,30,230,255" type="QString"/><Option name="size" value="5" type="QString"/><Option name="name" value="circle" type="QString"/></Option></layer></symbol></symbols></renderer-v2></qgis>"""

# gpkgstyle= 選択検証用の別スタイル(singleSymbol・緑マーカー)
QML_ALT = """<qgis version="3.28" styleCategories="Symbology"><renderer-v2 type="singleSymbol" forceraster="0" enableorderby="0" referencescale="-1" symbollevels="0"><symbols><symbol type="marker" name="0" alpha="1" force_rhr="0" clip_to_extent="1" frame_rate="10" is_animated="0"><layer class="SimpleMarker" enabled="1" pass="0" locked="0"><Option type="Map"><Option name="color" value="30,200,30,255" type="QString"/><Option name="size" value="8" type="QString"/><Option name="name" value="square" type="QString"/></Option></layer></symbol></symbols></renderer-v2></qgis>"""

# 実用 SLD(LineSymbolizer + Filter)。layer_styles.styleSLD と
# gpkgext_stylesheets(format=sld) の両方で流用する
SLD = """<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc">
 <NamedLayer><Name>ln</Name><UserStyle><Title>ln-sld</Title><FeatureTypeStyle>
  <Rule><Name>ln-default</Name><Title>線(既定)</Title>
   <LineSymbolizer><Stroke>
    <CssParameter name="stroke">#1f78b4</CssParameter>
    <CssParameter name="stroke-width">3</CssParameter>
    <CssParameter name="stroke-dasharray">6 3</CssParameter>
   </Stroke></LineSymbolizer>
   <TextSymbolizer>
    <Label><ogc:PropertyName>name</ogc:PropertyName></Label>
    <Font>
     <CssParameter name="font-family">Arial</CssParameter>
     <CssParameter name="font-size">12</CssParameter>
     <CssParameter name="font-weight">bold</CssParameter>
    </Font>
    <LabelPlacement><LinePlacement><PerpendicularOffset>4</PerpendicularOffset></LinePlacement></LabelPlacement>
    <Halo><Radius>1.5</Radius><Fill><CssParameter name="fill">#ffffff</CssParameter></Fill></Halo>
    <Fill><CssParameter name="fill">#1f78b4</CssParameter></Fill>
   </TextSymbolizer></Rule>
 </FeatureTypeStyle></UserStyle></NamedLayer>
</StyledLayerDescriptor>"""


def main():
    if os.path.exists(OUT):
        os.remove(OUT)
    con = sqlite3.connect(OUT)
    cur = con.cursor()

    cur.execute("PRAGMA application_id = 1196437808")  # 'GPKG'
    cur.execute("PRAGMA user_version = 10400")          # 1.4.0

    cur.executescript("""
    CREATE TABLE gpkg_spatial_ref_sys (
      srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY,
      organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
      definition TEXT NOT NULL, description TEXT);
    CREATE TABLE gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL,
      identifier TEXT UNIQUE, description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER,
      CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
    CREATE TABLE gpkg_geometry_columns (
      table_name TEXT NOT NULL, column_name TEXT NOT NULL,
      geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL,
      CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
      CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
      CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
    CREATE TABLE gpkg_extensions (
      table_name TEXT, column_name TEXT, extension_name TEXT NOT NULL,
      definition TEXT NOT NULL, scope TEXT NOT NULL,
      CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name));
    """)
    cur.executemany(
        "INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)",
        [
            ("Undefined Cartesian SRS", -1, "NONE", -1, "undefined", "undefined cartesian coordinate reference system"),
            ("Undefined Geographic SRS", 0, "NONE", 0, "undefined", "undefined geographic coordinate reference system"),
            ("WGS 84 geodetic", 4326, "EPSG", 4326,
             'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]',
             "longitude/latitude coordinates in decimal degrees"),
            ("WGS 84 / Pseudo-Mercator", 3857, "EPSG", 3857,
             'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],UNIT["metre",1]]',
             "spherical mercator (非経緯度: CRS 警告検証用)"),
            ("JGD2011 / Japan Plane Rectangular CS IX", 6677, "EPSG", 6677,
             'PROJCS["JGD2011 / Japan Plane Rectangular CS IX",GEOGCS["JGD2011",DATUM["Japanese_Geodetic_Datum_2011",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",40],PARAMETER["central_meridian",140.833333333333],PARAMETER["scale_factor",0.9999],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]',
             "平面直角座標系 IX系(内蔵 WKT 再投影検証用)"),
        ],
    )

    # ---- 地物表 pt(POINT) ----
    cur.execute("CREATE TABLE pt (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, cat TEXT, value REAL, geom BLOB NOT NULL)")
    pts = [
        ("東京", "high", 50, (139.767, 35.681)),
        ("大阪", "high", 40, (135.502, 34.693)),
        ("名古屋", "high", 30, (136.906, 35.170)),
        ("札幌", "low", 20, (141.346, 43.064)),
        ("福岡", "low", 10, (130.401, 33.590)),
        ("遠隔地", "low", 60, (0.0, 0.0)),  # 日本の bbox 外 — bbox=auto 検証用
    ]
    for name, cat, value, (x, y) in pts:
        cur.execute("INSERT INTO pt (name,cat,value,geom) VALUES (?,?,?,?)",
                    (name, cat, value, gpkg_binary(4326, wkb_point(x, y), envelope_of([(x, y)]))))
    cur.execute("INSERT INTO gpkg_contents VALUES ('pt','features','pt','',strftime('%Y-%m-%dT%H:%M:%fZ','now'),0,0,141.4,43.1,4326)")
    cur.execute("INSERT INTO gpkg_geometry_columns VALUES ('pt','geom','POINT',4326,0,0)")

    # ---- 地物表 ln(LINESTRING) — table= 解決検証用 ----
    cur.execute("CREATE TABLE ln (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, geom BLOB NOT NULL)")
    lines = [
        ("東名", [(139.767, 35.681), (136.906, 35.170), (135.502, 34.693)]),
        ("津軽線", [(140.7, 41.8), (141.0, 43.0)]),
    ]
    for name, coords in lines:
        cur.execute("INSERT INTO ln (name,geom) VALUES (?,?)",
                    (name, gpkg_binary(4326, wkb_linestring(coords), envelope_of(coords))))
    cur.execute("INSERT INTO gpkg_contents VALUES ('ln','features','ln','',strftime('%Y-%m-%dT%H:%M:%fZ','now'),135.5,34.6,141.0,43.0,4326)")
    cur.execute("INSERT INTO gpkg_geometry_columns VALUES ('ln','geom','LINESTRING',4326,0,0)")

    # ---- 非空間 attributes 表(gpkg_geometry_columns 登録なし) ----
    cur.execute("CREATE TABLE attr_table (id INTEGER PRIMARY KEY, label TEXT)")
    cur.executemany("INSERT INTO attr_table VALUES (?,?)", [(1, "a"), (2, "b")])
    cur.execute("INSERT INTO gpkg_contents VALUES ('attr_table','attributes','attr_table','',strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL,NULL,NULL,0)")

    # ---- 曲線ジオメトリ(WKB 8-17)表。CircularString→LineString・Triangle→Polygon
    #      の折線近似で 2 地物描画されることを検証する ----
    cur.execute("CREATE TABLE curves (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, geom BLOB NOT NULL)")
    # 半円に近い円弧 (135,34)-(136,36)-(137,34) の 3 制御点
    cur.execute("INSERT INTO curves (name,geom) VALUES (?,?)",
                ("円弧", gpkg_binary(4326, wkb_circularstring([(135.0, 34.0), (136.0, 36.0), (137.0, 34.0)]),
                                     (135.0, 137.0, 34.0, 36.0))))
    tri = [(138.0, 34.0), (139.0, 36.0), (140.0, 34.0), (138.0, 34.0)]
    cur.execute("INSERT INTO curves (name,geom) VALUES (?,?)",
                ("三角", gpkg_binary(4326, wkb_triangle([tri]), envelope_of(tri))))
    cur.execute("INSERT INTO gpkg_contents VALUES ('curves','features','curves','',strftime('%Y-%m-%dT%H:%M:%fZ','now'),135.0,34.0,140.0,36.0,4326)")
    cur.execute("INSERT INTO gpkg_geometry_columns VALUES ('curves','geom','GEOMETRY',4326,0,0)")
    cur.execute("INSERT INTO gpkg_extensions VALUES ('curves','geom','gpkg_geom_CIRCULARSTRING','http://www.geopackage.org/spec/#extension_geometry_types','read-write')")

    # ---- 非経緯度(投影座標系)表。srs_id=3857 → CRS 警告の検証用 ----
    cur.execute("CREATE TABLE proj (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, geom BLOB NOT NULL)")
    cur.execute("INSERT INTO proj (name,geom) VALUES (?,?)",
                ("東京(3857)", gpkg_binary(3857, wkb_point(15540720.0, 4258660.0), (15540720.0, 15540720.0, 4258660.0, 4258660.0))))
    cur.execute("INSERT INTO gpkg_contents VALUES ('proj','features','proj','',strftime('%Y-%m-%dT%H:%M:%fZ','now'),15540720.0,4258660.0,15540720.0,4258660.0,3857)")
    cur.execute("INSERT INTO gpkg_geometry_columns VALUES ('proj','geom','POINT',3857,0,0)")

    # ---- EPSG:6677(JGD2011 平面直角 IX系・横メルカトル)。
    # 3857 数式に乗らない投影で「GPKG 内蔵 WKT → proj4」経路を検証する。
    # 座標 (0,0) は原点定義 lon0=140.8333,lat0=40 → 再投影後 ≈(140.833, 40.0) ----
    cur.execute("CREATE TABLE proj6677 (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, geom BLOB NOT NULL)")
    cur.execute("INSERT INTO proj6677 (name,geom) VALUES (?,?)",
                ("原点(6677)", gpkg_binary(6677, wkb_point(0.0, 0.0), (0.0, 0.0, 0.0, 0.0))))
    cur.execute("INSERT INTO gpkg_contents VALUES ('proj6677','features','proj6677','',strftime('%Y-%m-%dT%H:%M:%fZ','now'),0.0,0.0,0.0,0.0,6677)")
    cur.execute("INSERT INTO gpkg_geometry_columns VALUES ('proj6677','geom','POINT',6677,0,0)")

    # ---- gpkg_data_columns(schema 拡張): pt の列タイトル ----
    cur.execute("""CREATE TABLE gpkg_data_columns (
      table_name TEXT NOT NULL, column_name TEXT NOT NULL, name TEXT,
      title TEXT, description TEXT, mime_type TEXT, constraint_name TEXT,
      CONSTRAINT pk_gdc PRIMARY KEY (table_name, column_name),
      CONSTRAINT fk_gdc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name))""")
    cur.executemany("INSERT INTO gpkg_data_columns (table_name,column_name,title,description) VALUES (?,?,?,?)", [
        ("pt", "name", "名称", "地点名"),
        ("pt", "cat", "分類", "高低分類"),
        ("pt", "value", "値", "計測値"),
    ])
    cur.execute("INSERT INTO gpkg_extensions VALUES ('pt',NULL,'gpkg_schema','http://www.geopackage.org/spec/#extension_schema','read-write')")
    # Related Tables 風の未対応拡張登録(警告検証用。実表は作らず登録行のみ)
    cur.execute("INSERT INTO gpkg_extensions VALUES ('attr_table',NULL,'gpkgext_relations','http://www.geopackage.org/spec/#extension_related_tables','read-write')")

    # ---- layer_styles(QGIS「データベースに保存」方式) ----
    cur.executescript("""
    CREATE TABLE layer_styles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      f_table_catalog VARCHAR(256), f_table_schema VARCHAR(256),
      f_table_name VARCHAR(256), f_geometry_column VARCHAR(256),
      styleName VARCHAR(30), styleQML XML, styleSLD XML,
      useAsDefault BOOLEAN, description TEXT, owner VARCHAR(30), ui XML,
      update_time DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    """)
    cur.execute("INSERT INTO layer_styles (f_table_name,f_geometry_column,styleName,styleQML,useAsDefault) VALUES ('pt','geom','default',?,1)", (QML,))
    # gpkgstyle=alt で選択できる別スタイル(非既定)
    cur.execute("INSERT INTO layer_styles (f_table_name,f_geometry_column,styleName,styleQML,useAsDefault) VALUES ('pt','geom','alt',?,0)", (QML_ALT,))
    # ln は styleSLD のみ(styleQML NULL) → SLD パーサ適用の検証用。
    # 同一 SLD を ln.sld としても出力する(compileSldStyle の直接検証用)
    cur.execute("INSERT INTO layer_styles (f_table_name,f_geometry_column,styleName,styleSLD,useAsDefault) VALUES ('ln','geom','sld-only',?,0)", (SLD,))
    with open(os.path.join(os.path.dirname(OUT), "ln.sld"), "w", encoding="utf-8") as f:
        f.write(SLD)

    # ---- OGC 24-050 Portrayal 拡張(ドラフト)のテーブル群。
    # 描画適用は未対応のため、登録検出と警告のみ検証する ----
    cur.executescript("""
    CREATE TABLE gpkgext_styles (
      id INTEGER PRIMARY KEY,
      style TEXT NOT NULL,
      description TEXT,
      uri TEXT,
      UNIQUE(uri));
    CREATE TABLE gpkgext_stylesheets (
      id INTEGER PRIMARY KEY,
      style_id INTEGER REFERENCES gpkgext_styles,
      format TEXT NOT NULL,
      stylesheet BLOB NOT NULL,
      UNIQUE(style_id, format));
    CREATE TABLE gpkgext_symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      uri TEXT,
      symbol TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT);
    CREATE TABLE gpkgext_symbol_content (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      format TEXT NOT NULL,
      content BLOB NOT NULL,
      uri TEXT NOT NULL);
    CREATE TABLE gpkgext_symbol_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      symbol_id INTEGER NOT NULL REFERENCES gpkgext_symbols,
      content_id INTEGER NOT NULL REFERENCES gpkgext_symbol_content,
      width INTEGER, height INTEGER,
      offset_x INTEGER, offset_y INTEGER, pixel_ratio INTEGER);
    CREATE TABLE gpkgext_fonts (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE,
      font BLOB,
      glyphs BLOB);
    CREATE TABLE gpkgext_semantic_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      description TEXT,
      uri TEXT NOT NULL,
      UNIQUE(type, uri));
    CREATE TABLE gpkgext_sa_reference (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      table_name TEXT NOT NULL,
      key_column_name TEXT,
      key_value INTEGER,
      sa_id INTEGER NOT NULL REFERENCES gpkgext_semantic_annotations);
    """)
    cur.execute("INSERT INTO gpkgext_styles VALUES (1,'demo-style','検証用スタイル','gpkgstyle::test::canvas::demo')")
    cur.execute("INSERT INTO gpkgext_stylesheets VALUES (1,1,'sld',?)", (SLD,))
    # mbstyle: source.url = GeoDataClass URI → sa_reference 経由で pt 表へ紐付く。
    # sprite は同ディレクトリの sprite.png+sprite.json(gpkg と同階層の相対 URL)。
    # circle/symbol(icon-image) のほか fill/line レイヤと gpkgsym 参照を含め、
    # 非 maplibre エンジンの compiled-spec 変換経路(curves 表)も検証できる構成にする
    MBSTYLE = '{"version":8,"name":"demo-mbstyle","sprite":"sprite","sources":{"pts":{"type":"geojson","url":"gpkgtest://geodataclass/pt"}},"layers":['\
        '{"id":"pt-circles","type":"circle","source":"pts","paint":{"circle-color":"#e6550d","circle-radius":9,"circle-stroke-color":"#ffffff","circle-stroke-width":2}},'\
        '{"id":"pt-icons","type":"symbol","source":"pts","layout":{"icon-image":"mysquare","icon-size":1,"icon-allow-overlap":true}},'\
        '{"id":"pt-gpkgsym","type":"symbol","source":"pts","layout":{"icon-image":"circle","icon-size":1,"icon-allow-overlap":true}},'\
        '{"id":"cv-fill","type":"fill","source":"pts","paint":{"fill-color":"#31a354","fill-opacity":0.4,"fill-outline-color":"#006d2c"}},'\
        '{"id":"cv-line","type":"line","source":"pts","paint":{"line-color":"#3182bd","line-width":3,"line-dasharray":[2,1]}}]}'
    cur.execute("INSERT INTO gpkgext_stylesheets VALUES (2,1,'mbstyle',?)", (MBSTYLE,))
    # mbstyle sprite.png(16x16 青) + sprite.json(mysquare のみ)
    with open(os.path.join(os.path.dirname(OUT), "sprite.png"), "wb") as f:
        f.write(make_png(16, 16, b"\x00\x00\xff\xff"))
    with open(os.path.join(os.path.dirname(OUT), "sprite.json"), "w", encoding="utf-8") as f:
        f.write('{"mysquare":{"x":0,"y":0,"width":16,"height":16,"pixelRatio":1}}')
    cur.execute("INSERT INTO gpkgext_symbols (uri,symbol,title,description) VALUES ('gpkgsym::test::canvas::demo::circle','circle','Circle',NULL)")
    cur.execute("INSERT INTO gpkgext_symbol_content (format,content,uri) VALUES ('image/png',?,'gpkgsym://test/circle.png')",
                (make_png(16, 16, b"\xff\x00\x00\xff"),))
    cur.execute("INSERT INTO gpkgext_symbol_images (symbol_id,content_id,width,height,pixel_ratio) VALUES (1,1,16,16,1)")
    cur.execute("INSERT INTO gpkgext_fonts (id,name,font,glyphs) VALUES (1,'test-font',?,?)",
                (b"\x00\x01\x00\x00" + b"\x00" * 16, make_zip({"0-255.pbf": b"gpkgtest-glyphs"})))
    # OGC 24-049 semantic-annotations: pt 表と demo-style を同一
    # GeoDataClass へ紐付ける(mbstyle の適用先解決に使う)。curves 表にも
    # 別 GeoDataClass 経由で同一スタイルを紐付け、layer_styles を持たない
    # 表での compiled-spec 適用経路を検証する
    cur.execute("INSERT INTO gpkgext_semantic_annotations (type,title,description,uri) VALUES ('GeoDataClass','ポイント地物クラス','テスト用 GeoDataClass','gpkgtest://geodataclass/pt')")
    cur.execute("INSERT INTO gpkgext_semantic_annotations (type,title,description,uri) VALUES ('GeoDataClass','ジオメトリ地物クラス','曲線検証用 GeoDataClass','gpkgtest://geodataclass/curves')")
    cur.execute("INSERT INTO gpkgext_sa_reference (table_name,key_column_name,key_value,sa_id) VALUES ('pt',NULL,NULL,1)")
    cur.execute("INSERT INTO gpkgext_sa_reference (table_name,key_column_name,key_value,sa_id) VALUES ('curves',NULL,NULL,2)")
    cur.execute("INSERT INTO gpkgext_sa_reference (table_name,key_column_name,key_value,sa_id) VALUES ('gpkgext_styles','id',1,1)")
    cur.execute("INSERT INTO gpkgext_sa_reference (table_name,key_column_name,key_value,sa_id) VALUES ('gpkgext_styles','id',1,2)")
    for tn, en in [
        ("gpkgext_styles", "gpkgext_styles"),
        ("gpkgext_stylesheets", "gpkgext_styles"),
        ("gpkgext_symbols", "gpkgext_symbols"),
        ("gpkgext_symbol_content", "gpkgext_symbols"),
        ("gpkgext_symbol_images", "gpkgext_symbols"),
        ("gpkgext_fonts", "gpkgext_fonts"),
        ("gpkgext_semantic_annotations", "gpkgext_semantic_annotations"),
        ("gpkgext_sa_reference", "gpkgext_semantic_annotations"),
    ]:
        cur.execute("INSERT INTO gpkg_extensions VALUES (?,NULL,?,'http://www.opengis.net/is/geopackage-styling/1.0','read-write')", (tn, en))

    # ---- rtree 空間索引(pt) — 実ファイルは索引付きが普通。sql.js は読めない前提の検証対象 ----
    try:
        cur.executescript("""
        CREATE VIRTUAL TABLE "rtree_pt_geom" USING rtree(id, minx, maxx, miny, maxy);
        INSERT INTO rtree_pt_geom SELECT id, minx, maxx, miny, maxy FROM (
          SELECT id,
            0.0 AS minx, 0.0 AS maxx, 0.0 AS miny, 0.0 AS maxy FROM pt);
        """)
        # rtree 中身は GPkgBinary エンベロープと一致させる
        cur.execute("DELETE FROM rtree_pt_geom")
        for rid, (name, cat, value, (x, y)) in enumerate(pts, start=1):
            cur.execute("INSERT INTO rtree_pt_geom VALUES (?,?,?,?,?)", (rid, x, x, y, y))
        cur.execute("INSERT INTO gpkg_extensions VALUES ('pt','geom','gpkg_rtree_index','http://www.geopackage.org/spec/#extension_rtree','write-only')")
    except sqlite3.Error as e:
        print("rtree 作成スキップ:", e, file=sys.stderr)

    con.commit()
    con.close()
    size = os.path.getsize(OUT)
    print(f"created {OUT} ({size} bytes)")


if __name__ == "__main__":
    main()
