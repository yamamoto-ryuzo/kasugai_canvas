// KASUGAI Canvas — vendor 依存エンジン共通ガード（非モジュール・head 同期用）
// web/vendor/ は配布物・リポジトリに同梱しない。vendor が必要なエンジン
// （navara・gsimaps）は本ファイルをガード inline script の前に読み込み、
// vendorGuardProbe(probeUrl) で SW 制御の確定を待ってから起動する。
// Service Worker 前提（SW 非対応環境のフォールバックは持たない）。
//
// 仕組み: vendor-proxy-sw.js を登録すると、スコープ配下の vendor/* GET/HEAD は
// SW が上流オリジナル（vendor.json のピン先: jsdelivr/raw.githubusercontent）
// から同一オリジン供給する。これによりローカルアプリ(:8510)に加え github.io
// のような静的配信でも Worker・iframe 制御の同一オリジン制約を満たしたまま
// 外部 CDN 直読みできる。
(function () {
  // vendor ミラーの明示オーバーライド（?hosted=<base> または
  // localStorage:kasugai_hosted_base）。指定時のみ SW はミラーモード
  // (<base>/vendor/* を参照)で動く。未指定 = オリジナル直読み
  var explicitHosted = (function () {
    var h = new URLSearchParams(location.search).get("hosted");
    if (h) return h;
    try { h = localStorage.getItem("kasugai_hosted_base") || ""; } catch (e) {}
    // vendored mirror は廃止済み（vendor 供給はオリジナル直読みに一本化）。
    // 旧既定値(kasugai-canvas-web)が localStorage に残っていると
    // ミラーモードで全 vendor/* が 404 になるため、保存値を無効化する
    if (h && /kasugai-canvas-web/i.test(h)) {
      try { localStorage.removeItem("kasugai_hosted_base"); } catch (e) {}
      return "";
    }
    return h;
  })();

  // ミラーの場合のみ SW スクリプト URL の ?u= で供給元を渡す（postMessage だと
  // 初回プローブと競合し得るため）。登録→活性化(clients.claim)完了を待つ Promise
  var swUrl = new URL("../vendor-proxy-sw.js", location.href);
  if (explicitHosted) {
    swUrl.search = "?u=" + encodeURIComponent(explicitHosted.replace(/\/?$/, "/"));
  }
  var swReg = null;
  var swReady = ("serviceWorker" in navigator)
    ? navigator.serviceWorker
        .register(swUrl)
        .then(function (reg) {
          swReg = reg;
          return navigator.serviceWorker.ready;
        })
        .then(function () {
          // ready は active 化を待つが、初回は controller 反映が僅かに遅れる
          // ことがある。制御確定前にプローブすると実体なし 404 で誤判定する
          // ため controllerchange まで待つ（timeout 付き）。
          // 「controller が居る」だけでは不十分: 旧版SW(?u=付き登録)が制御中
          // だったり新SWが installing/waiting 中なら、controllerchange で
          // 新版への切替を待たないと旧版経路で 404 になる
          var ctl = navigator.serviceWorker.controller;
          var updating = swReg && (swReg.installing || swReg.waiting);
          if (ctl && ctl.scriptURL === swUrl.href && !updating) return null;
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
  // 戻り値は参考情報（到達可否の確認用）で、呼び出し側は結果に関わらず
  // 起動する。SW 中継が効く環境ではローカル実体が無くても true が返る
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
        var ctl = navigator.serviceWorker && navigator.serviceWorker.controller;
        if (ok || !ctl) return ok;
        return new Promise(function (res) { setTimeout(res, 600); })
          .then(function () { return headProbe(abs); });
      });
    });
  };
})();
