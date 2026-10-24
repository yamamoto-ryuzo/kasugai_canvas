// QGIS geo_webview プラグインの /kasugai エンドポイントを呼び出し、
// 現在の QGIS プロジェクトを KASUGAI Canvas プロジェクトとして取り込む。
//
// 前提: QGIS 側で geo_webview プラグインの HTTP サーバー(既定 8089)が
// 起動していること。ボタン押下 → QGIS 側で .kasc+DATA/ 生成 →
// KASUGAI ローカルサーバーへ外部プロジェクト登録 → switchProject で
// この画面のプロジェクトが切り替わる。
//
// manifest.options: { "port": 8089 } で geo_webview のポートを指定できる。

const DEFAULT_PORT = 8089;

export async function init(api, manifest) {
  const port = Number(manifest?.options?.port || DEFAULT_PORT);
  const host = document.querySelector("#layers-panel");
  if (!host) {
    console.warn("[qgis-import] #layers-panel が見つかりません");
    return;
  }

  const box = document.createElement("div");
  box.id = "qgis-import-box";
  box.style.cssText = "margin:4px 0 10px;padding:8px;border:1px solid #dbe4e8;border-radius:6px;";

  const btn = document.createElement("button");
  btn.id = "qgis-import-btn";
  btn.type = "button";
  btn.textContent = "QGISから取り込み";
  btn.style.cssText = "width:100%;";

  const status = document.createElement("p");
  status.id = "qgis-import-status";
  status.className = "hint";
  status.setAttribute("aria-live", "polite");
  status.style.cssText = "margin:6px 0 0;font-size:0.85em;";

  box.append(btn, status);
  host.prepend(box);

  const setStatus = (msg, isError = false) => {
    status.textContent = msg;
    status.style.color = isError ? "#a82020" : "";
  };

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    setStatus(`QGIS(geo_webview :${port})へエクスポートを要求中…`);
    try {
      const res = await fetch(`http://localhost:${port}/kasugai`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setStatus(`取り込み失敗: ${data?.error || res.status}`, true);
        return;
      }
      if (data.url) {
        // QGIS 側が register + switchProject 済み。同じ画面なら
        // コマンド経路で自動切替されるが、保険としてここでも切替える
        const m = /[?&]project=([^&]+)/.exec(data.url);
        const projectId = m ? decodeURIComponent(m[1]) : null;
        setStatus(`取り込み完了: ${data.layers ?? "?"}レイヤ / ${data.tiles ?? "?"}タイル`);
        if (projectId && typeof api.switchProject === "function") {
          await api.switchProject(projectId);
        }
      } else {
        setStatus(`出力のみ完了(KASUGAI未起動): ${data.dir || ""}`);
      }
    } catch (e) {
      setStatus(
        `QGIS 側に接続できません(localhost:${port})。` +
        `geo_webview の HTTP サーバーが起動しているか確認してください`, true);
    } finally {
      btn.disabled = false;
    }
  });

  api.registerPlugin({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    dispose() {
      box.remove();
    },
  });
}
