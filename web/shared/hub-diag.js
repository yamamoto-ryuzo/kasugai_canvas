// bridge-hub(127.0.0.1:8511)の /vector を指すベクターレイヤーが失敗した場合、
// ハブの状態を疎通して原因(未起動/旧版/duckdb なし/ソース未登録)をエラーへ付記する。
// 全エンジン共通（元々 cesium/app.js で実装されたものを shared へ集約）。
import { t } from "./i18n.js";

const HUB_URL_RE = /^https?:\/\/(127\.0\.0\.1|localhost):8511\//i;
const HUB_SOURCE_RE = /\/vector\/(?:geojson|tilejson)\/([^/?#]+)/i;

export async function diagnoseHubLayerError(item, error) {
  const url = item && item.url;
  if (!HUB_URL_RE.test(url || "")) return error;
  let hint = null;
  let health = null;
  try {
    const res = await fetch("http://127.0.0.1:8511/health", { signal: AbortSignal.timeout(1500) });
    if (res.ok) health = await res.json().catch(() => null);
  } catch { /* unreachable */ }
  if (!health) {
    hint = t("layer.hubDown");
  } else if (health.hub !== true) {
    hint = t("layer.hubNotHub");
  } else if (!("vector" in health)) {
    hint = t("layer.hubOld");
  } else if (health.vector && health.vector.duckdb === false) {
    hint = t("layer.hubNoDuckdb");
  } else {
    const name = HUB_SOURCE_RE.exec(url)?.[1];
    if (name) {
      try {
        const res = await fetch("http://127.0.0.1:8511/vector/sources", { signal: AbortSignal.timeout(2000) });
        const body = res.ok ? await res.json().catch(() => null) : null;
        const sources = body && (body.sources || body);
        if (sources && typeof sources === "object") {
          const entry = sources[decodeURIComponent(name)];
          if (!entry) {
            hint = t("layer.hubNoSource", { name: decodeURIComponent(name) });
          } else if (entry.missing === true) {
            hint = t("layer.hubSourceMissing", { name: decodeURIComponent(name) });
          } else if (entry.materializing === true) {
            hint = t("layer.hubSourceLoading", { name: decodeURIComponent(name) });
          }
        }
      } catch { /* ソース確認は付加情報なので失敗しても握りつぶす */ }
    }
  }
  if (!hint) return error;
  const base = String(error?.message || error || "");
  return new Error(base ? `${base} — ${hint}` : hint);
}
