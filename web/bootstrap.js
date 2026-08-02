const deckVersion = "9.3.7";
const deckCdnUrl = packageName =>
  `https://unpkg.com/${packageName}@${deckVersion}/dist.min.js`;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`deck.gl script could not be loaded: ${url}`));
    document.head.append(script);
  });
}

async function loadDeckModules() {
  await loadScript(deckCdnUrl("deck.gl"));
  window.__deckCore = window.deck;
  await loadScript(deckCdnUrl("@deck.gl/geo-layers"));
  window.__deckGeoLayers = window.deck;
}

try {
  await loadDeckModules();
  await loadScript(deckCdnUrl("@deck.gl/extensions"));
  window.deck = Object.assign(
    {},
    window.__deckCore || {},
    window.__deckGeoLayers || {},
    window.deck || {},
  );
  await import("/app.js");
} catch (error) {
  console.error(error);
  document.body.insertAdjacentHTML(
    "afterbegin",
    "<p>deck.gl拡張の初期化に失敗しました。ブラウザのコンソールを確認してください。</p>",
  );
}
