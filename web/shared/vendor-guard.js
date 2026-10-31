// KASUGAI Canvas — vendor 依存エンジン共通ガード（非モジュール・head 同期用）
// web/vendor/ は配布物・リポジトリに同梱しない。vendor が必要なエンジン
// （navara・gsimaps）は本ファイルをガード inline script の前に読み込み、
// vendorGuardProbe(probeUrl) で供給可否を調べてから起動/転送を振り分ける。
//
// 仕組み: vendor-proxy-sw.js を登録すると、スコープ配下の vendor/* GET/HEAD は
// SW が「ローカル実体 → CDN(kasugai-canvas-web)」の順で同一オリジン供給する。
// これにより :8510 のサーバープロキシに加え github.io のような静的配信でも
// Worker・iframe 制御の同一オリジン制約を満たしたまま CDN 直読みできる。
// SW 非対応・登録失敗時はプローブが素通しで 404 になり、呼び出し側の
// 転送フォールバックへ委ねる。
(function () {
  var DEFAULT_HOSTED = "https://yamamoto-ryuzo.github.io/kasugai-canvas-web/stable/";

  // 転送先ベース（?hosted=<base> または localStorage:kasugai_hosted_base で上書き可）
  window.vendorHostedBase = function () {
    var h = new URLSearchParams(location.search).get("hosted");
    if (!h) { try { h = localStorage.getItem("kasugai_hosted_base") || ""; } catch (e) {} }
    return (h || DEFAULT_HOSTED).replace(/\/?$/, "/");
  };

  // 転送先は SW スクリプト URL の ?u= で渡す（postMessage だと初回プローブと
  // 競合し得るため）。登録→活性化(clients.claim)完了を待つ Promise
  var swReady = ("serviceWorker" in navigator)
    ? navigator.serviceWorker
        .register(new URL("../vendor-proxy-sw.js?u=" +
          encodeURIComponent(window.vendorHostedBase()), location.href))
        .then(function () { return navigator.serviceWorker.ready; })
        .then(function () {
          // ready は active 化を待つが、初回は controller 反映が僅かに遅れる
          // ことがある。制御確定前にプローブすると実体なし 404 で誤転送する
          // ため controllerchange まで待つ（timeout 付き・既に制御済みなら即）
          if (navigator.serviceWorker.controller) return null;
          return new Promise(function (res) {
            var t = setTimeout(res, 3000);
            navigator.serviceWorker.addEventListener("controllerchange", function () {
              clearTimeout(t);
              res();
            }, { once: true });
          });
        })
        .catch(function () { return null; })
    : Promise.resolve(null);

  // SW 制御確定後に probeUrl を HEAD で調べ、供給可否(true/false)を返す。
  // SW 中継が効く環境ではローカル実体が無くても true が返る
  function headProbe(absUrl) {
    return fetch(absUrl, { method: "HEAD", cache: "no-store" })
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
  }
  window.vendorGuardProbe = function (probeUrl) {
    var abs = new URL(probeUrl, location.href);
    return swReady.then(function () {
      return headProbe(abs).then(function (ok) {
        // controller 反映後も fetch 中継の有効化が一拍遅れる環境があるため、
        // SW 制御下で 404 だった場合のみ待って再試行してから判定する
        if (ok || !navigator.serviceWorker.controller) return ok;
        return new Promise(function (res) { setTimeout(res, 600); })
          .then(function () { return headProbe(abs); });
      });
    });
  };
})();
