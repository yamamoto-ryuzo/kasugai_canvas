// .kasc fly_geojson: 行 → player-api フック（getFlyPaths/persistFlyPath/
// syncFlyPathLine）のエンジン共通実装。各エンジンは doc.unsupported のうち
// type==="fly_geojson" の item を setItems へ渡し、残りのフックを
// createPlayerApi へそのまま展開する。
// persist は fileWrite 可能なローカルサーバー版のみ（静的配信ではメモリ登録のみ
// で false を返し、memoryFlyPaths 側の非永続ルートが維持される）。

export function createKascFlyPaths({ resolveUrl, getInspectorText, setInspectorText }) {
  let items = [];
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };

  // doc.unsupported（または任意の item 列）から fly_geojson: 行を登録する
  const setItems = list => {
    items = (Array.isArray(list) ? list : []).filter(i => i && i.type === "fly_geojson");
  };

  // speed は m/s（.kasc 行の speed= と同じ）。setFlySettings の書き戻し用に _item を持たせる
  const getFlyPaths = () => items.map(item => {
    const o = item.opts || {};
    return {
      title: item.title || item.url,
      url: resolveUrl ? resolveUrl(item.url) : item.url,
      speed: num(o.speed), height: num(o.height), pitch: num(o.pitch),
      loop: /^(true|1|on|yes)$/i.test(o.loop || ""), view: o.view,
      _item: item,
    };
  });

  // flyRoute/addFlyPath の永続化: GeoJSON を DATA/ へ保存し fly_geojson: 行を追記
  const persistFlyPath = async (title, geojson, path) => {
    const safe = String(title || "route").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "route";
    const name = `fly_${safe}.geojson`;
    const r = await window.kasugaiApi.saveDataFile(name, JSON.stringify(geojson)).catch(() => null);
    if (!r?.ok) return false;
    const opts = [`speed=${Math.round(path.speed * 10) / 10}`];
    if (Number.isFinite(path.height)) opts.push(`height=${path.height}`);
    if (Number.isFinite(path.pitch)) opts.push(`pitch=${path.pitch}`);
    if (path.loop) opts.push("loop=true");
    const line = `fly_geojson:${title}|DATA/${name}|${opts.join("|")}`;
    setInspectorText(`${(getInspectorText() || "").replace(/\s*$/, "")}\n${line}\n`);
    // セッション内でも getFlyPaths が拾えるよう item 登録（memoryFlyPaths と同名なら先勝ちで一つに見える）
    items.push({
      type: "fly_geojson", title, url: `DATA/${name}`, visible: true,
      opts: Object.fromEntries(opts.map(o => o.split("="))), line,
    });
    return true;
  };

  // setFlySettings で書き換えた item.opts をインスペクタの fly_geojson: 行へ反映
  const syncFlyPathLine = item => {
    const text = getInspectorText?.() || "";
    if (!item?.line || !text.includes(item.line)) return;
    const o = item.opts || {};
    const parts = [`fly_geojson:${item.title || ""}`, item.url || ""];
    for (const k of ["speed", "height", "pitch", "step", "view"]) {
      if (o[k] !== undefined && o[k] !== "") parts.push(`${k}=${o[k]}`);
    }
    if (o.loop) parts.push(`loop=${o.loop}`);
    const nl = parts.join("|");
    setInspectorText(text.replace(item.line, nl));
    item.line = nl;
  };

  return { setItems, getFlyPaths, persistFlyPath, syncFlyPathLine };
}
