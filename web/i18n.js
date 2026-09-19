// 軽量 i18n。辞書は ./i18n/<lang>.json、言語は localStorage("kasugaiLanguage") に保存。
// 未設定時のデフォルトは英語。data-i18n / data-i18n-html / data-i18n-attr 属性で静的DOMを一括置換する。
// 辞書は en(フォールバック)と現在言語のみ読み込み、切替時に必要なものを遅延取得する。

const STORAGE_KEY = "kasugaiLanguage";
export const SUPPORTED_LANGUAGES = ["en", "ja", "zh", "ko", "es", "fr", "de", "pt"];
export const LANGUAGE_NAMES = {
  en: "English",
  ja: "日本語",
  zh: "中文",
  ko: "한국어",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
};

let currentLang = "en";
const dicts = {};
const loading = {};
let initPromise = null;

async function loadDict(lang) {
  try {
    const response = await fetch(new URL(`./i18n/${lang}.json`, import.meta.url), { cache: "no-store" });
    if (response.ok) return await response.json();
  } catch (error) {
    console.warn(`[i18n] 辞書の読み込みに失敗: ${lang}`, error);
  }
  return {};
}

function ensureDict(lang) {
  if (!dicts[lang]) {
    if (!loading[lang]) loading[lang] = loadDict(lang).then(dict => { dicts[lang] = dict; });
    return loading[lang];
  }
  return Promise.resolve();
}

function normalizeLang(lang) {
  if (typeof lang !== "string") return "en";
  if (SUPPORTED_LANGUAGES.includes(lang)) return lang;
  const base = lang.toLowerCase().split("-")[0];
  return SUPPORTED_LANGUAGES.includes(base) ? base : "en";
}

export function getLanguage() {
  return currentLang;
}

export function initI18n() {
  if (!initPromise) {
    initPromise = (async () => {
      let stored = null;
      try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) {}
      // 未選択時はブラウザ言語を初期値にし、未対応なら英語にフォールバック
      let nav = "";
      try { nav = navigator.language || ""; } catch (e) {}
      currentLang = normalizeLang(stored || nav || "en");
      await Promise.all([ensureDict("en"), ensureDict(currentLang)]);
      document.documentElement.lang = currentLang;
    })();
  }
  return initPromise;
}

export function t(key, params) {
  let text = dicts[currentLang]?.[key] ?? dicts.en?.[key] ?? key;
  if (params && typeof params === "object") {
    text = text.replace(/\{(\w+)\}/g, (match, name) => (params[name] != null ? String(params[name]) : match));
  }
  return text;
}

export function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-html]").forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll("[data-i18n-attr]").forEach(el => {
    el.dataset.i18nAttr.split(";").forEach(pair => {
      const index = pair.indexOf(":");
      if (index < 0) return;
      el.setAttribute(pair.slice(0, index).trim(), t(pair.slice(index + 1).trim()));
    });
  });
}

export async function setLanguage(lang) {
  lang = normalizeLang(lang);
  if (lang === currentLang) return;
  await ensureDict(lang);
  currentLang = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
  document.documentElement.lang = lang;
  applyI18n();
  window.dispatchEvent(new CustomEvent("kasugai:language-changed", { detail: { lang } }));
}
