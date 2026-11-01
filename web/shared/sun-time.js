// 太陽日時コントロール（タイムゾーン選択＋日時入力＋時刻スライダー）エンジン共通。
// 3 コントロールは「選択タイムゾーンのローカル日時」を表示し、正となる時刻は
// UTC 瞬間 sunUtcMs で一元管理する。どれを操作しても他方が追従する。

// 日時入力用タイムゾーン（主要国・地域の固定オフセット）。既定は日本
export const SUN_TIMEZONES = [
  ["日本 (UTC+9)", 9],
  ["オーストラリア東部 (UTC+10)", 10],
  ["中国・シンガポール (UTC+8)", 8],
  ["インド (UTC+5:30)", 5.5],
  ["ドバイ (UTC+4)", 4],
  ["モスクワ (UTC+3)", 3],
  ["中央ヨーロッパ (UTC+1)", 1],
  ["イギリス・UTC (UTC±0)", 0],
  ["ブラジル (UTC-3)", -3],
  ["ニューヨーク (UTC-5)", -5],
  ["シカゴ (UTC-6)", -6],
  ["デンバー (UTC-7)", -7],
  ["ロサンゼルス (UTC-8)", -8],
  ["ハワイ (UTC-10)", -10],
];

const _p2 = n => String(n).padStart(2, "0");
// UTC 瞬間(ms) → 選択タイムゾーンのローカル日時文字列(datetime-local 値)
export const fmtLocal = (utcMs, offMin) => {
  const d = new Date(utcMs + offMin * 60000);
  return `${d.getUTCFullYear()}-${_p2(d.getUTCMonth() + 1)}-${_p2(d.getUTCDate())}T${_p2(d.getUTCHours())}:${_p2(d.getUTCMinutes())}`;
};
// datetime-local 値 → UTC 瞬間(ms)（選択タイムゾーンとして解釈）
export const parseLocal = (s, offMin) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ""));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - offMin * 60000 : null;
};

// els: { tz: <select>, datetime: <input datetime-local>, hour: <input range> }
// onChange(sunUtcMs) が各コントロール操作・初期化時に呼ばれる。
// 戻り値: { utcMs, setUtcMs(ms) } — 外部から時刻をセットしたい場合用
export function mountSunControls(els, onChange) {
  let sunUtcMs = 0;
  const offMin = () => Number(els.tz?.value ?? 9) * 60;
  const sync = (opts = {}) => {
    if (!opts.keepDatetime && els.datetime) els.datetime.value = fmtLocal(sunUtcMs, offMin());
    if (!opts.keepHour && els.hour) {
      els.hour.value = String((((Math.round((sunUtcMs + offMin() * 60000) / 60000)) % 1440) + 1440) % 1440 / 60);
    }
  };
  const apply = () => onChange(sunUtcMs);

  if (els.tz && !els.tz.options.length) {
    for (const [label, off] of SUN_TIMEZONES) {
      const o = document.createElement("option");
      o.value = String(off); o.textContent = label;
      if (off === 9) o.selected = true;
      els.tz.append(o);
    }
  }
  // 初期日時は当日 10:00（選択ゾーンのローカル時刻）
  {
    const off = offMin();
    const local = new Date(Date.now() + off * 60000);
    sunUtcMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 10, 0) - off * 60000;
  }
  sync(); apply();

  // 日時入力: 選択ゾーンのローカル日時として解釈し太陽へ反映（スライダーは追従）
  els.datetime?.addEventListener("input", e => {
    const utcMs = parseLocal(e.target.value, offMin());
    if (utcMs == null) return;
    sunUtcMs = utcMs; apply(); sync({ keepDatetime: true });
  });
  // 時刻スライダー: 現在のローカル日付を保ったまま時刻だけ変更する
  els.hour?.addEventListener("input", e => {
    const off = offMin();
    const l = new Date(sunUtcMs + off * 60000);
    sunUtcMs = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), 0, Math.round(Number(e.target.value) * 60)) - off * 60000;
    apply(); sync({ keepHour: true });
  });
  // タイムゾーン変更は太陽の瞬間を保ち、両コントロールの表示を換算する
  els.tz?.addEventListener("change", () => { sync(); apply(); });

  return {
    get utcMs() { return sunUtcMs; },
    setUtcMs(ms) { sunUtcMs = ms; sync(); apply(); },
  };
}
