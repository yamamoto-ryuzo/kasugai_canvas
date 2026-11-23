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
//   ・live.controls(follow/selection)は QGIS 側が正。geo_webview パネルの
//    Live タブ/POST /live/controls/bridge から更新され、本モジュールが
//    /live/state 経由で検出して適用する(Canvas 側パネルは接続バッジのみ)
//   ・live.add_layers は QGIS 側からのレイヤ追加要求キュー。未処理 seq を
//    検出してエンジンの addLiveLayer(title) フックへ振る
// エンジンは configureLive(doc, hooks) を各プロジェクト描画後に呼ぶ。
// hooks: { baseUrl, kascUrl, applyKascText, getView, applySelection,
//          addLiveLayer }
// ?follow=<base|top> は configureFollow({apply}) で live セッションへ統合。
let session = null;

export function configureLive(doc, hooks = {}) {
  const liveUrl = doc?.live?.url || "";
  if (!/^https?:\/\//i.test(liveUrl)) { stopLive(); return; }
  // live: 行の | follow オプションは規定で有効化するが、ユーザーが切替
  // した後(followUserSet)は再適用で上書きしない。同時に新規セッション
  // 確立時は QGIS 側 controls の初期値として1回だけ POST /live/controls
  // {follow:true} する(QSettings=全ライブビューア共通の正へ反映)
  if (doc?.live?.follow && !followUserSet) liveFollowEnabled = true;
  if (!session) session = new LiveSession();
  session.configure({
    liveUrl, pushFollow: !!doc?.live?.follow, ...hooks });
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

// 接続状態の購読(live-panel バッジ用)。
// cb({active,connected,follow,selection,lastAdd}) → 解除関数を返す
const statusListeners = new Set();
export function onLiveStatus(cb) {
  if (typeof cb === "function") statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}
function emitLiveStatus() {
  if (!statusListeners.size) return;
  const st = liveStatus();
  for (const cb of statusListeners) {
    try { cb(st); } catch (_) { /* リスナー例外は無視 */ }
  }
}

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
// live: 行の follow / 外部 API で有効化する QGIS キャンバス追従。
// QGIS 側が正なので POST /live/controls でも通知し、応答が回れば
// /live/state 経由で同じ値が返ってくる(往復しても値は同じ)
export function liveSetFollow(on) {
  liveFollowEnabled = !!on;
  followUserSet = true;
  if (session?.cfg) void session.post("/live/controls", { follow: liveFollowEnabled });
  emitLiveStatus();
  return liveFollowEnabled;
}
export function liveIsFollowing() { return liveFollowEnabled; }
export function liveFollowAvailable() { return typeof engineFollowApply === "function"; }
// QGIS 側選択ハイライトの表示切替(OFF で受信適用を止め表示を消す)。
// applyLiveState からの QGIS 側正適用でも通るため、POST は発信側
// (外部 API 呼出)のみが必要になるよう opts で制御する
export function liveSetSelectionVisible(on, { notify = true } = {}) {
  selVisible = !!on;
  if (notify && session?.cfg) void session.post("/live/controls", { selection: selVisible });
  if (!on && session?.cfg?.applySelection) {
    try { session.cfg.applySelection({ layers: [] }); } catch (_) { /* 無視 */ }
  } else if (session) {
    session.selSig = ""; // 再有効化で次回ポーリングの署名差分を取り直す
  }
  emitLiveStatus();
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
let followUserSet = false;
// ユーザー入力起点のカメラ操作判定窓。ポインタ/ホイール/タッチ/キー入力の
// あった直後だけ /live/camera 送信を許可し、follow 適用や flyTo 等の
// プログラム移動が QGIS へエコーされるのを防ぐ(入力起点ルール)
let userCamInputUntil = 0;
function markUserCamInput() { userCamInputUntil = Date.now() + 2500; }
if (typeof document !== "undefined") {
  const _io = { capture: true, passive: true };
  for (const ev of ["pointerdown", "wheel", "touchstart", "keydown"]) {
    document.addEventListener(ev, markUserCamInput, _io);
  }
  // ドラグ継続中(ボタン押下中の移動)も入力中として窓を延ばす
  document.addEventListener("pointermove",
    e => { if (e.buttons) markUserCamInput(); }, _io);
}
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
  // QGIS が送る mpp3857(EPSG:3857 面の m/px)があれば、それから
  // Web Mercator ズームを直接導く。QGIS 側の zoom は縮尺→近似テーブルの
  // 推定値で誤差があるため、追従表示の見た目が QGIS とずれる原因になる。
  // mpp3857 経由なら QGIS キャンバスと同じ m/px が再現され全エンジン共通で一致する
  if (Number.isFinite(canvas.mpp3857) && canvas.mpp3857 > 0) {
    canvas = { ...canvas, zoom: Math.log2(156543.03392 / canvas.mpp3857) };
  }
  const key = followKeyOf(canvas);
  // 自分が /live/camera で送った位置のエコーは適用しない。適用すると
  // moveEnd→(入力窓が残っていれば)再POST→再変換の往復で微振動する。
  // 位置が違えば「ユーザーが QGIS を動かした」実変更なので通常適用する。
  // スキップ時も lastFollowKey を進めて、同状態の継続ポーリングで
  // 再適用が発生しないようにする
  const pe = sess?.pushedEcho;
  if (pe && Date.now() < pe.until) {
    sess.pushedEcho = null;
    const dLon = Math.abs(canvas.lon - (pe.lon ?? NaN));
    const dLat = Math.abs(canvas.lat - (pe.lat ?? NaN));
    // zoom は照合しない: QGIS(縮尺由来)とエンジン(カメラ高さ由来)で
    // 換算式が根本的に違い、常に数レベルずれ得るため。エコー判定は
    // lon/lat(=実際に送った値がそのまま返る)のみで行う
    if (dLon < 5e-4 && dLat < 5e-4) {
      lastFollowKey = key;
      return;
    }
  }
  if (key === lastFollowKey) return;
  lastFollowKey = key;
  // 起動直後の初期抑止(configure の +10s)を follow 適用で縮めないよう max を取る
  if (sess) sess.camHoldUntil = Math.max(sess.camHoldUntil || 0, Date.now() + 1300);
  for (const f of followReg) {
    try { f.apply(canvas); } catch (_) { /* エンジン側適用失敗は無視 */ }
  }
  // live: 行の follow オプション(?follow 登録が無い場合のみ重複適用を避けて呼ぶ)
  // apply のシグネチャは (canvasState, {topdown}) — 第2引数を渡さないと
  // 分割代入で TypeError になり follow が無言で死ぬ(pitch 保持の既定)
  if (!followReg.length && liveFollowEnabled && engineFollowApply) {
    try { engineFollowApply(canvas, { topdown: false }); } catch (_) { /* 同上 */ }
  }
}

// /live/state 応答の共通処理(選択ハイライト + フォロー追従)
// QGIS 側選択の検出は2系統: (a) data.live.qgis_selection
// ({layers:[{layer,ids,count}],rev} … live_sync の選択監視が更新)か
// (b) data.selection.sig(署名リスト)で rev/署名が変わったら
// GET /live/selection から選択地物 GeoJSON を取得して
// エンジンの applySelection(fc) へ渡してハイライト表示する
function applyLiveState(data, sess = null) {
  // QGIS 側が正の制御フラグ(geo_webview Live タブ / POST /live/controls /
  // bridge liveSetControls いずれの経路でも同じ値が live.controls へ出る)。
  // 到着したらローカルの follow/選択表示フラグへ適用する。follow 適用は
  // liveSetFollow 相当(followUserSet=true で kasc | follow の再適用を抑止)
  const ctl = data?.live?.controls;
  if (ctl && typeof ctl === "object") {
    if (typeof ctl.follow === "boolean") {
      liveFollowEnabled = ctl.follow;
      followUserSet = true;
    }
    if (typeof ctl.selection === "boolean"
        && ctl.selection !== selVisible) {
      liveSetSelectionVisible(ctl.selection, { notify: false });
    }
  }
  // QGIS 側からのレイヤ追加要求キュー(未処理 seq のみ順に適用)。
  // addLiveLayer フックを持たないエンジンではスキップする。
  // 追加は fetch 込みの非同期処理なので、同一 title の連続要求が
  // 重複追加にならないようセッション内の promise チェーンで直列化する
  const pending = data?.live?.add_layers;
  if (Array.isArray(pending) && sess) {
    // サーバ再起動で seq が巻き戻った(観測最大値が処理済みより小さい)
    // 場合は処理済み位置を取り直して新キュー全体を処理対象にする
    const maxSeq = Math.max(0, ...pending.map(r => Number(r?.seq) || 0));
    if (pending.length && maxSeq < (sess.addSeq || 0)) sess.addSeq = 0;
    const reqs = [];
    for (const req of pending) {
      const seq = Number(req?.seq) || 0;
      if (seq <= (sess.addSeq || 0)) continue;
      sess.addSeq = seq;
      const title = String(req?.title || "");
      if (title && typeof sess.cfg?.addLiveLayer === "function") {
        reqs.push(title);
      }
    }
    if (reqs.length) {
      const fn = sess.cfg.addLiveLayer;
      sess.addChain = (sess.addChain || Promise.resolve()).then(async () => {
        for (const title of reqs) {
          try {
            const res = await fn(title);
            sess.lastAdd = { title, ok: true, added: res?.added };
          } catch (e) {
            sess.lastAdd = { title, ok: false, error: String(e?.message || e) };
          }
          emitLiveStatus();
        }
      });
    }
  }
  // 選択表示フラグ(selVisible=live.controls.selection)が OFF の間は
  // QGIS 側選択の取得・適用を行わない(ハイライトは OFF 時に除去済み。
  // 再有効化は selSig リセット済みのため次回署名差分で取り直す)
  if (sess?.cfg?.applySelection && selVisible) {
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
  // ?follow 登録がある場合だけでなく live: 行の | follow でも
  // QGIS キャンバス位置を適用する(従来は followReg 必須で、
  // live: 行経由では /live/state を読んでもカメラ追従が起きなかった)
  if (followReg.length || (liveFollowEnabled && engineFollowApply)) {
    applyFollowCanvas(data?.canvas, sess);
  }
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
    this.stateTimer = null;
    this.camTimer = null;
    this.sendDisabled = false;
    this.sendRetryAt = 0;
    this.busy = false;
    this.stateDisabled = false;
    this.camHoldUntil = 0;
    this.pushedEcho = null;
    this.addSeq = 0;      // 処理済みの live.add_layers seq
    this.lastAdd = null;  // 直近のレイヤ追加結果(バッジ表示用)
    this.stateOk = false; // 直近 /live/state 取得の成否
    this.followOptPushed = false; // | follow を QGIS 側へ反映済みか
  }
  configure(cfg) {
    const changed = !this.cfg || this.cfg.baseUrl !== cfg.baseUrl
      || this.cfg.liveUrl !== cfg.liveUrl;
    this.cfg = cfg;
    if (changed) {
      this.rev = 0;
      this.selSig = "";
      this.addSeq = 0;    // seq はサーバごとの連番(新規セッションは 1 から)
      this.lastAdd = null;
      this.stateDisabled = false;
      this.sendDisabled = false;
      this.sendRetryAt = 0;
      // 起動直後の初期カメラ位置(デフォルト/復元位置)の逆送は、
      // 入力起点ゲート(userCamInputUntil)側で既に遮断されるため
      // ここでの初期 hold は不要(残すと起動直後の正当なユーザードラッグを
      // 誤って抑制する)。follow 適用後のエコー抑止は applyFollowCanvas 側で行う
      // 既存 live.json を即読みして現在 rev を掴む(初回適用は行わない)
      void this.tick(true);
    }
    if (!this.timer) this.timer = setInterval(() => void this.tick(), 1500);
    // /live/state は follow/選択のリアルタイム反映用に 1.5s タイマーとは
    // 分離して速く回す(ローカルループバックなので 400ms でも負荷は僅か。
    // 内部で follow/applySelection 有無・document.hidden を判定して早期 return)
    if (!this.stateTimer) {
      this.stateTimer = setInterval(() => void this.tickState(), 400);
    }
    // セッション確立後は standalone ポーラへ任せずこちらで処理する
    if (followPoller) followPoller.stop();
    // live: 行の | follow 要求は新規セッション時に1回だけ QGIS 側へ反映
    if (changed && cfg.pushFollow && !this.followOptPushed) {
      this.followOptPushed = true;
      void this.post("/live/controls", { follow: true });
    }
    emitLiveStatus();
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.stateTimer) { clearInterval(this.stateTimer); this.stateTimer = null; }
    this.cfg = null;
    this.stateOk = false;
    emitLiveStatus();
  }
  status() {
    return {
      active: !!this.cfg, rev: this.rev,
      live: this.cfg?.liveUrl || null,
      sendDisabled: this.sendDisabled,
      follow: followReg.length > 0 || liveFollowEnabled,
      selection: selVisible,
      connected: this.stateOk,
      lastAdd: this.lastAdd,
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
  // QGIS 側選択(qgis_selection)・QGIS キャンバス位置(follow)・
  // controls/add_layers(QGIS 側正の制御)を反映する。
  // controls は QGIS 側から follow/selection を後から切替えられるため、
  // 現在値に関わらずセッション中は常時ポーリングする
  async tickState() {
    if (!this.cfg || this.stateDisabled) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const url = this.cfg.liveUrl.replace(/\/$/, "") + "/live/state";
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 404) this.stateDisabled = true;
        this.stateOk = false;
        emitLiveStatus();
        return;
      }
      const data = await res.json();
      this.stateOk = true;
      applyLiveState(data, this);
      emitLiveStatus();
    } catch (_) {
      this.stateOk = false;
      emitLiveStatus();
      /* QGIS 停止中は次の tick で追従 */
    }
  }
  // liveSync プッシュ(/api/command)またはポーリング検出からの適用。
  // args.selection は QGIS 側選択の即時プッシュ(ハイライト専用)
  async update(args = {}) {
    if (!this.cfg) return { ok: false, reason: "inactive" };
    if (args?.selection && selVisible) {
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
    // ユーザー入力起点のカメラ移動のみ送信する。マウス/タッチ/キー操作=
    // 発信側、follow 適用・flyTo・初期カメラ等の API 移動=受信側として
    // 振り分け、双方向性を保ったまま QGIS→Canvas→QGIS ループを断つ
    if (Date.now() > userCamInputUntil) return;
    // フォロー適用直後の moveEnd エコーを抑制(QGIS→Canvas→QGIS の往復防止)
    if (Date.now() < this.camHoldUntil) return;
    if (this.camTimer) return;
    this.camTimer = setTimeout(() => {
      this.camTimer = null;
      const view = this.cfg?.getView?.() || {};
      // 自分が送った view が /live/state 経由でエコーとして帰ってくるのを
      // 識別するため記録(次の applyFollowCanvas で近似一致したら適用しない)
      this.pushedEcho = {
        lon: view.longitude ?? view.lon,
        lat: view.latitude ?? view.lat,
        zoom: view.zoom,
        until: Date.now() + 5000,
      };
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
