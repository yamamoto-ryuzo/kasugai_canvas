import { showLoginForm } from "../../auth-login-form.js";

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
  return showLoginForm({
    onSubmit: async ({ user, pass }) => {
      if (user !== EXPECTED_USER) {
        throw new Error("認証に失敗しました");
      }
      const salt = base64ToBuffer(EXPECTED_SALT);
      const hash = await deriveHash(user, pass, salt);
      const expected = base64ToBuffer(EXPECTED_HASH);
      if (hash.length !== expected.length || !hash.every((v, i) => v === expected[i])) {
        throw new Error("認証に失敗しました");
      }
      return { token: "password", user: { name: user, role: "password" } };
    }
  });
}
