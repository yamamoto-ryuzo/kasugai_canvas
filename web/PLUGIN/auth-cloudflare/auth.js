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
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(255,255,255,0.96);display:flex;align-items:center;justify-content:center;z-index:100000;font-family:sans-serif;";

    const box = document.createElement("div");
    box.style.cssText = "width:320px;padding:24px;border:1px solid #cbd9de;border-radius:8px;background:#fff;box-shadow:0 4px 20px rgba(0,0,0,0.1);";

    const title = document.createElement("h2");
    title.textContent = "KASUGAI Canvas ログイン";
    title.style.cssText = "margin:0 0 16px;font-size:1.2em;color:#1d2b35;";

    const userLabel = document.createElement("label");
    userLabel.textContent = "ユーザーID";
    userLabel.style.cssText = "display:block;margin-bottom:4px;font-size:0.9em;color:#4a5a65;";

    const userInput = document.createElement("input");
    userInput.type = "text";
    userInput.autocomplete = "username";
    userInput.style.cssText = "width:100%;padding:8px;margin-bottom:12px;border:1px solid #cbd9de;border-radius:4px;box-sizing:border-box;";

    const passLabel = document.createElement("label");
    passLabel.textContent = "パスワード";
    passLabel.style.cssText = "display:block;margin-bottom:4px;font-size:0.9em;color:#4a5a65;";

    const passInput = document.createElement("input");
    passInput.type = "password";
    passInput.autocomplete = "current-password";
    passInput.style.cssText = "width:100%;padding:8px;margin-bottom:16px;border:1px solid #cbd9de;border-radius:4px;box-sizing:border-box;";

    const error = document.createElement("div");
    error.style.cssText = "color:#a82020;font-size:0.85em;margin-bottom:12px;min-height:1.2em;";

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "ログイン";
    submit.style.cssText = "width:100%;padding:10px;background:#1d6a96;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:0.95em;";

    const form = document.createElement("form");
    form.appendChild(title);
    form.appendChild(userLabel);
    form.appendChild(userInput);
    form.appendChild(passLabel);
    form.appendChild(passInput);
    form.appendChild(error);
    form.appendChild(submit);
    box.appendChild(form);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.textContent = "";
      const user = userInput.value.trim();
      const pass = passInput.value;
      if (!user || !pass) {
        error.textContent = "ユーザーIDとパスワードを入力してください";
        return;
      }
      submit.disabled = true;
      submit.textContent = "認証中...";
      try {
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
        document.body.removeChild(overlay);
        resolve({ token: data.token || "cloudflare", user: { name: user, role: "cloudflare" } });
      } catch (err) {
        error.textContent = err.message || "認証に失敗しました";
        submit.disabled = false;
        submit.textContent = "ログイン";
      }
    });
  });
}
