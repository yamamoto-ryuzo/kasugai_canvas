import { showLoginForm } from "../../auth-login-form.js";

function base64ToBuffer(base64) {
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

async function importDataKey(dataKey) {
  const raw = base64ToBuffer(dataKey);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
}

async function decryptKasc(buffer, key) {
  const data = new Uint8Array(buffer);
  const iv = data.slice(0, 12);
  const cipher = data.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

function patchFetch(key) {
  const originalFetch = window.fetch;
  window.fetch = async (input, init) => {
    let url = input;
    if (typeof input !== "string") {
      if (input && typeof input.url === "string") url = input.url;
      else if (input && typeof input.href === "string") url = input.href;
      else url = String(input);
    }
    if (typeof url === "string" && url.endsWith(".kasc")) {
      const res = await originalFetch(url + ".enc", init);
      if (!res.ok) {
        throw new Error("暗号化プロジェクトの取得に失敗しました");
      }
      const buf = await res.arrayBuffer();
      const text = await decryptKasc(buf, key);
      return new Response(text, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return originalFetch(input, init);
  };
}

export async function authenticate() {
  return showLoginForm({
    onSubmit: async ({ user, pass }) => {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, pass })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "認証に失敗しました");
      }
      if (data.dataKey) {
        const key = await importDataKey(data.dataKey);
        patchFetch(key);
      }
      return { token: data.token || "cloudflare", user: { name: user, role: "cloudflare" } };
    }
  });
}
