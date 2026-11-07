// QGIS geo_webview ライブ双方向連携(shared/live.js)
// .kasc の `live: <QGIS HTTPサーバ base URL>` 行を検出すると:
//   ・同じ場所(= .kasc 基準 baseUrl)の live.json を 1.5s ポーリングし、
//    rev 増加で .kasc を再読込 → エンジン側フックへ差分適用を依頼
//   ・Canvas アプリ(:8510)稼働時は geo_webview が /api/command の
//    liveSync ツールをプッシュ → liveUpdate() で即時反映
//   ・カメラ/選択は POST <base>/live/camera・/live/selection へ逆通知
// エンジンは configureLive(doc, hooks) を各プロジェクト描画後に呼ぶ。
let session = null;

export function configureLive(doc, hooks = {}) {
  const liveUrl = doc?.live?.url || "";
  if (!/^https?:\/\//i.test(liveUrl)) { stopLive(); return; }
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

class LiveSession {
  constructor() {
    this.cfg = null;
    this.rev = 0;
    this.timer = null;
    this.camTimer = null;
    this.sendDisabled = false;
    this.sendRetryAt = 0;
    this.busy = false;
  }
  configure(cfg) {
    const changed = !this.cfg || this.cfg.baseUrl !== cfg.baseUrl
      || this.cfg.liveUrl !== cfg.liveUrl;
    this.cfg = cfg;
    if (changed) {
      this.rev = 0;
      this.sendDisabled = false;
      this.sendRetryAt = 0;
      // 既存 live.json を即読みして現在 rev を掴む(初回適用は行わない)
      void this.tick(true);
    }
    if (!this.timer) this.timer = setInterval(() => void this.tick(), 1500);
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
    if (!url) return;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => null);
      const rev = Number(data?.rev) || 0;
      if (!this.rev) { this.rev = rev; return; }
      if (rev && rev !== this.rev && !initOnly) {
        this.rev = rev;
        await this.applyUpdate(data);
      }
    } catch (_) { /* QGIS 停止中は次の tick で追従 */ }
  }
  // liveSync プッシュ(/api/command)またはポーリング検出からの適用
  async update(args = {}) {
    if (!this.cfg || this.busy) return { ok: false, reason: "busy" };
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
    if (this.sendDisabled && Date.now() < this.sendRetryAt) return;
    try {
      const res = await fetch(this.cfg.liveUrl.replace(/\/$/, "") + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.sendDisabled = false;
    } catch (_) {
      // QGIS サーバ未起動等: 送信を抑止し 60 秒後に再試行する
      this.sendDisabled = true;
      this.sendRetryAt = Date.now() + 60000;
    }
  }
}
