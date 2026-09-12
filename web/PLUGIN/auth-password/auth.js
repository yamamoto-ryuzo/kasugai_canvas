const EXPECTED_USER = "admin";
const EXPECTED_SALT = "2tr4Cnrn5LXfo6fpf7ozNg==";
const EXPECTED_HASH = "67mzCzSXZtPm1xNbLmYgPN+ME4F974mZ+qqIxKOu5Zg=";

// このファイルは単純なハッシュ比較による「なんちゃって認証」です
// 環境変数・クラウド・サーバーを必要とせず、起動制御だけを行います
// GLWAN など限定的な環境での緩いアクセス制御を想定しています
// 真のセキュリティはありません（ハッシュはファイル内にあります）
// パスワードを変更する場合は以下で新しい SALT / HASH を生成してください
// python -c "import base64,secrets,hashlib; s=secrets.token_bytes(16); h=hashlib.pbkdf2_hmac('sha256',b'USER:PASS',s,100000,32); print(base64.b64encode(s).decode()); print(base64.b64encode(h).decode())"

function base64ToBuffer(base64) {
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

async function deriveHash(user, pass, salt) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(`${user}:${pass}`), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    base,
    256
  );
  return new Uint8Array(bits);
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
        if (user !== EXPECTED_USER) {
          throw new Error("認証に失敗しました");
        }
        const salt = base64ToBuffer(EXPECTED_SALT);
        const hash = await deriveHash(user, pass, salt);
        const expected = base64ToBuffer(EXPECTED_HASH);
        if (hash.length !== expected.length || !hash.every((v, i) => v === expected[i])) {
          throw new Error("認証に失敗しました");
        }
        document.body.removeChild(overlay);
        resolve({ token: "password", user: { name: user, role: "password" } });
      } catch (err) {
        error.textContent = err.message || "認証に失敗しました";
        submit.disabled = false;
        submit.textContent = "ログイン";
      }
    });
  });
}
