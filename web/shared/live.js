// QGIS geo_webview ライブ双方向連携(shared/live.js)
// .kasc の `live: <QGIS HTTPサーバ base URL>` 行を検出すると:
//   ・同じ場所(= .kasc 基準 baseUrl)の live.json を 1.5s ポーリングし、
//    rev 増加で .kasc を再読込 → エンジン側フックへ差分適用を依頼
//   ・Canvas アプリ(:8510)稼働時は geo_webview が /api/command の
//    liveSync ツールをプッシュ → liveUpdate() で即時反映
//   ・カメラ/選択は POST <base>/live/camera・/live/selection へ逆通知
//   ・表示/フィルタ/テーマ変更は POST /live/writeback へ書き戻し、
//    作図/GeoJSON は POST /live/features で QGIS スクラッチレイヤへ投入
//   ・<base>/live/state をポーリングし、QGIS 側の選択変更(→地物ハイライト)
//    と QGIS キャンバス位置(→ ?follow カメラ追従)をエンジンへ反映
// エンジンは configureLive(doc, hooks) を各プロジェクト描画後に呼ぶ。
// hooks: { baseUrl, kascUrl, applyKascText, getView, applySelection }
// ?follow=<base|top> は configureFollow({apply}) で live セッションへ統合。
let session = null;

export function configureLive(doc, hooks = {}) {
  const liveUrl = doc?.live?.url || "";
  if (!/^https?:\/\//i.test(liveUrl)) { stopLive(); return; }
  // live: 行の | follow オプションは一度有効化したら維持する
  // (インスペクタ再適用でユーザーの手動解除を上書きしない)
  if (doc?.live?.follow) liveFollowEnabled = true;
  if (!session) session = new LiveSession();
  session.configure({ liveUrl, ...hooks });
}

export function stopLive() { if (session) session.stop(); }
export function liveStatus() { return session ? session.status() : { active: false }; }
// /api/command (liveSync)・kasugaiApi.liveSync からの即時反映
export async function liveUpdate(args = {}) {
  if (!session) return { ok: false, reason: "inactive" };
  return session.update(args);
}
export function liveNotifyCamera() { if (session) session.notifyCamera(); }
export function liveNotifySelection(payload) { if (session) session.notifySelection(payload); }

// live セッションが有効か(作図/レイヤー → QGIS 投入ボタンの活性判定用)
export function liveIsActive() { return !!session?.cfg; }

// GeoJSON FeatureCollection を QGIS 側スクラッチレイヤへ投入する。
// POST /live/features。戻り値は応答 JSON({ok, added, layer} 等)
export async function liveSendFeatures(name, geojson) {
  if (!session) return { ok: false, reason: "inactive" };
  return session.postJson("/live/features", { name, geojson });
}

// Canvas 側のレイヤ表示状態/テーマ/フィルタを QGIS プロジェクトへ書き戻す。
// POST /live/writeback {layers:[{title,visible,where?}], theme?}
// entries は各エンジンの layerEntries({item:{title,visible,opts}})または
// cesium の getOrderedLayerItems() の item をそのまま渡せる
export async function liveWritebackEntries(entries, { theme } = {}) {
  if (!session?.cfg) return { ok: false, reason: "inactive" };
  const layers = (entries || []).map(e => {
    const item = (e && typeof e === "object" && e.item) ? e.item : e;
    const where = item?.where ?? item?.opts?.where;
    return {
      title: item?.sourceTitle || item?.title || "",
      visible: item?.visible !== false,
      ...(where != null ? { where: String(where) } : {}),
    };
  }).filter(l => l.title);
  return session.postJson("/live/writeback", { layers, theme: theme || null });
}

// ---- live セッションの追加操作(QGIS → Canvas の状態・取得系) ----
export function liveBase() { return session?.cfg?.liveUrl || null; }
// live: 行の follow / UI トグルで有効化する QGIS キャンバス追従
export function liveSetFollow(on) { liveFollowEnabled = !!on; return liveFollowEnabled; }
export function liveIsFollowing() { return liveFollowEnabled; }
export function liveFollowAvailable() { return typeof engineFollowApply === "function"; }
// QGIS 側選択ハイライトの表示切替(OFF で受信適用を止め表示を消す)
export function liveSetSelectionVisible(on) {
  selVisible = !!on;
  if (!on && session?.cfg?.applySelection) {
    try { session.cfg.applySelection({ layers: [] }); } catch (_) { /* 無視 */ }
  } else if (session) {
    session.selRev = 0; // 再有効化で次回ポーリングの rev 差分を取り直す
  }
}
export function liveSelectionVisible() { return selVisible; }

// GET /live/layers: QGIS プロジェクトのレイヤカタログ
export function liveQueryLayers() {
  if (!session?.cfg) return Promise.resolve({ ok: false, reason: "inactive" });
  return session.getJson("/live/layers", 30000);
}
// GET /live/features: レイヤ地物の取得(GeoJSON)。
// opts: {bbox:[w,s,e,n](4326), pt:[lon,lat], tol, limit, offset}
export function liveQueryFeatures(title, opts = {}) {
  if (!session?.cfg) return Promise.resolve({ ok: false, reason: "inactive" });
  const q = new URLSearchParams({ layer: String(title || "") });
  if (Array.isArray(opts.bbox)) q.set("bbox", opts.bbox.join(","));
  if (Array.isArray(opts.pt)) q.set("pt", opts.pt.join(","));
  if (opts.tol != null) q.set("tol", String(opts.tol));
  if (opts.limit != null) q.set("limit", String(opts.limit));
  if (opts.offset != null) q.set("offset", String(opts.offset));
  return session.getJson(`/live/features?${q}`, 60000);
}
// GET /live/selection: QGIS 側選択地物(GeoJSON・明示取得用)
export function liveFetchSelection(max = 800) {
  if (!session?.cfg) return Promise.resolve({ ok: false, reason: "inactive" });
  return session.getJson(`/live/selection?max=${Number(max) || 800}`, 30000);
}
// GET /live/render のURLを組み立てる(QGIS描画フォールバック画像)
// bbox は EPSG:4326。transparent=透過PNG(既定)。layers=kascタイトル配列
export function liveRenderUrl({ bbox, w, h, layers, transparent = true } = {}) {
  if (!session?.cfg || !Array.isArray(bbox)) return null;
  const q = new URLSearchParams({
    bbox: bbox.join(","),
    w: String(Math.max(1, Math.round(w || 1024))),
    h: String(Math.max(1, Math.round(h || 768))),
  });
  if (transparent) q.set("bg", "transparent");
  if (Array.isArray(layers) && layers.length) q.set("layers", layers.join(","));
  return session.cfg.liveUrl.replace(/\/$/, "") + "/live/render?" + q.toString();
}

// ---- ?follow/present の登録(live セッション統合版カメラ追従) ----
// apply(canvasState, {topdown}) を登録する。canvasState は
// geo_webview の _canvas_state_dict (lon/lat/zoom/rotation/mupp/scale)。
// 3D エンジンは pitch を保持して適用し、topdown 指定時のみ真俯瞰へ戻す。
const followReg = [];
let followPoller = null;
let lastFollowKey = "";
let followLegacy = false;   // /live/state 未対応の旧サーバ → /present/state
// live: 行の | follow オプション用。エンジンの configureFollow apply を
// 記憶しておき、live セッション確立時は ?follow 無しでも追従できる
let engineFollowApply = null;
let liveFollowEnabled = false;
// QGIS 側選択の Canvas ハイライト表示フラグ(OFF で受信適用を止めて消す)
let selVisible = true;

export function configureFollow({ apply, topdown = false } = {}) {
  if (typeof apply === "function") engineFollowApply = apply;
  const p = new URLSearchParams(location.search);
  if (!p.has("follow") && !p.has("present")) return;
  const raw = p.get("follow") || p.get("present") || "";
  const base = /^https?:\/\//i.test(raw) ? raw : null;
  const td = topdown || /^(top|flat|2d|ortho)$/i.test(raw);
  if (typeof apply !== "function") return;
  followReg.push({ base, apply: s => apply(s, { topdown: td }) });
  if (session) void session.tickState();
  else { followPoller ??= new FollowPoller(); followPoller.start(); }
}

function followBase() {
  return followReg.find(r => r.base)?.base ?? session?.cfg?.liveUrl ?? "";
}

// QGIS キャンバス状態の重複適用を避けるシグネチャ
function followKeyOf(s) {
  return [s.lon, s.lat, s.zoom, s.rotation, s.scale]
    .map(v => Number(v ?? NaN).toFixed(6)).join("|");
}

function applyFollowCanvas(canvas, sess = null) {
  if (!canvas || typeof canvas.lon !== "number" || typeof canvas.lat !== "number") return;
  const key = followKeyOf(canvas);
  if (key === lastFollowKey) return;
  lastFollowKey = key;
  if (sess) sess.camHoldUntil = Date.now() + 1300;
  for (const f of followReg) {
    try { f.apply(canvas); } catch (_) { /* エンジン側適用失敗は無視 */ }
  }
  // live: 行の follow オプション(?follow 登録が無い場合のみ重複適用を避けて呼ぶ)
  if (!followReg.length && liveFollowEnabled && engineFollowApply) {
    try { engineFollowApply(canvas); } catch (_) { /* 同上 */ }
  }
}

// /live/state 応答の共通処理(選択ハイライト + フォロー追従)
// QGIS 側選択の検出は2系統: (a) data.live.qgis_selection
// ({layers:[{layer,ids,count}],rev} … live_sync の選択監視が更新)か
// (b) data.selection.sig(署名リスト)で rev/署名が変わったら
// GET /live/selection から選択地物 GeoJSON を取得して
// エンジンの applySelection(fc) へ渡してハイライト表示する
function applyLiveState(data, sess = null) {
  if (sess?.cfg?.applySelection) {
    const qs = data?.live?.qgis_selection;
    const sig = qs !== undefined && qs !== null
      ? (qs.rev ?? JSON.stringify(qs))
      : (data?.selection?.sig !== undefined
        ? JSON.stringify(data.selection.sig) : undefined);
    if (sig !== undefined && String(sig) !== sess.selSig) {
      sess.selSig = String(sig);
      const base = sess.cfg.liveUrl.replace(/\/$/, "");
      void (async () => {
        let fc = { type: "FeatureCollection", features: [] };
        try {
          const r = await fetch(`${base}/live/selection`, { cache: "no-store" });
          if (r.ok) {
            const d = await r.json();
            fc = d?.geojson || d || fc;
          }
        } catch (_) { /* 取得失敗は空ハイライト(解除) */ }
        try { sess.cfg?.applySelection?.(fc); } catch (_) { /* 無視 */ }
      })();
    }
  }
  if (followReg.length) applyFollowCanvas(data?.canvas, sess);
}

// live セッションが無い環境(standalone ?follow=)専用のポーラ。
// セッションが後から確立したら tickState 側へ処理を譲り自身は停止する
class FollowPoller {
  constructor() { this.timer = null; }
  start() {
    if (!this.timer) this.timer = setInterval(() => void this.tick(), 1500);
    void this.tick();
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  async tick() {
    if (session || !followReg.length) { this.stop(); return; }
    const base = followBase().replace(/\/$/, "");
    const url = followLegacy ? `${base}/present/state` : `${base}/live/state`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 404 && !followLegacy) followLegacy = true;
        return;
      }
      const data = await res.json();
      if (followLegacy) applyFollowCanvas(data); // /present/state は canvas dict 直返し
      else applyLiveState(data);
    } catch (_) { /* 接続不可時は前回状態を維持 */ }
  }
}

class LiveSession {
  constructor() {
    this.cfg = null;
    this.rev = 0;
    this.selSig = "";
    this.timer = null;
    this.camTimer = null;
    this.sendDisabled = false;
    this.sendRetryAt = 0;
    this.busy = false;
    this.stateDisabled = false;
    this.camHoldUntil = 0;
  }
  configure(cfg) {
    const changed = !this.cfg || this.cfg.baseUrl !== cfg.baseUrl
      || this.cfg.liveUrl !== cfg.liveUrl;
    this.cfg = cfg;
    if (changed) {
      this.rev = 0;
      this.selSig = "";
      this.stateDisabled = false;
      this.sendDisabled = false;
      this.sendRetryAt = 0;
      // 既存 live.json を即読みして現在 rev を掴む(初回適用は行わない)
      void this.tick(true);
    }
    if (!this.timer) this.timer = setInterval(() => void this.tick(), 1500);
    // セッション確立後は standalone ポーラへ任せずこちらで処理する
    if (followPoller) followPoller.stop();
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.cfg = null;
  }
  status() {
    return {
      active: !!this.cfg, rev: this.rev,
      live: this.cfg?.liveUrl || null,
      sendDisabled: this.sendDisabled,
      follow: followReg.length > 0,
    };
  }
  manifestUrl() {
    const base = this.cfg?.baseUrl;
    return base ? new URL("live.json", base).href : null;
  }
  async tick(initOnly = false) {
    if (!this.cfg || this.busy) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const url = this.manifestUrl();
    if (url) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json().catch(() => null);
        const rev = Number(data?.rev) || 0;
        if (!this.rev) { this.rev = rev; }
        else if (rev && rev !== this.rev && !initOnly) {
          this.rev = rev;
          await this.applyUpdate(data);
        }
      } catch (_) { /* QGIS 停止中は次の tick で追従 */ }
    }
    await this.tickState();
  }
  // live.json とは別に <liveUrl>/live/state を読み、
  // QGIS 側選択(qgis_selection)と QGIS キャンバス位置(follow)を反映する
  async tickState() {
    if (!this.cfg || this.stateDisabled) return;
    if (!this.cfg.applySelection && !followReg.length
        && !(liveFollowEnabled && engineFollowApply)) return;
    const url = this.cfg.liveUrl.replace(/\/$/, "") + "/live/state";
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 404) this.stateDisabled = true;
        return;
      }
      const data = await res.json();
      applyLiveState(data, this);
    } catch (_) { /* QGIS 停止中は次の tick で追従 */ }
  }
  // liveSync プッシュ(/api/command)またはポーリング検出からの適用。
  // args.selection は QGIS 側選択の即時プッシュ(ハイライト専用)
  async update(args = {}) {
    if (!this.cfg) return { ok: false, reason: "inactive" };
    if (args?.selection) {
      try { await this.cfg.applySelection?.(args.selection); } catch (_) { /* 無視 */ }
    }
    const hasManifest = args.rev != null || !!args.full || Array.isArray(args.changed);
    if (!hasManifest) return { ok: true, selection: !!args?.selection };
    if (this.busy) return { ok: false, reason: "busy" };
    return this.applyUpdate({
      rev: Number(args?.rev) || this.rev,
      changed: Array.isArray(args?.changed) ? args.changed : [],
      full: !!args?.full,
    });
  }
  async applyUpdate(manifest = {}) {
    if (!this.cfg || this.busy) return { ok: false, reason: "busy" };
    this.busy = true;
    try {
      const kascUrl = this.cfg.kascUrl
        || new URL("kasugai_canvas.kasc", this.cfg.baseUrl).href;
      const res = await fetch(kascUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`kasc HTTP ${res.status}`);
      const text = await res.text();
      const changed = (manifest.changed || [])
        .map(c => (typeof c === "string" ? c : (c?.title || "")))
        .filter(Boolean);
      await this.cfg.applyKascText?.(text, { changed, full: !!manifest.full, manifest });
      if (manifest.rev) this.rev = Math.max(this.rev, Number(manifest.rev) || 0);
      return { ok: true, changed };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    } finally {
      this.busy = false;
    }
  }
  notifyCamera() {
    if (!this.cfg || !this.cfg.getView) return;
    // フォロー適用直後の moveEnd エコーを抑制(QGIS→Canvas→QGIS の往復防止)
    if (Date.now() < this.camHoldUntil) return;
    if (this.camTimer) return;
    this.camTimer = setTimeout(() => {
      this.camTimer = null;
      const view = this.cfg?.getView?.() || {};
      void this.post("/live/camera", view);
    }, 400);
  }
  notifySelection(payload) {
    if (!this.cfg) return;
    void this.post("/live/selection", payload || {});
  }
  async post(path, body) {
    const r = await this.postJson(path, body);
    if (!r.ok && r.reason === "offline") return;
  }
  // 応答 JSON が必要な POST(/live/features・/live/writeback 等)
  async postJson(path, body) {
    if (!this.cfg) return { ok: false, reason: "inactive" };
    if (this.sendDisabled && Date.now() < this.sendRetryAt)
      return { ok: false, reason: "offline" };
    try {
      const res = await fetch(this.cfg.liveUrl.replace(/\/$/, "") + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, reason: `HTTP ${res.status} ${text.slice(0, 200)}` };
      }
      this.sendDisabled = false;
      return await res.json().catch(() => ({ ok: true }));
    } catch (e) {
      // QGIS サーバ未起動等: 送信を抑止し 60 秒後に再試行する
      this.sendDisabled = true;
      this.sendRetryAt = Date.now() + 60000;
      return { ok: false, reason: "offline", error: String(e?.message || e) };
    }
  }
  // 応答 JSON が必要な GET(/live/layers・/live/features 等)
  async getJson(path, timeoutMs = 15000) {
    if (!this.cfg) return { ok: false, reason: "inactive" };
    try {
      const res = await fetch(this.cfg.liveUrl.replace(/\/$/, "") + path, {
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        return { ok: false, reason: `HTTP ${res.status}` };
      }
      return (data && typeof data === "object") ? data : { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e?.message || e) };
    }
  }
}
