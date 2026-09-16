const enc = new TextEncoder();

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function createToken(secret, ttlMs = 12 * 60 * 60 * 1000) {
  const expiry = String(Date.now() + ttlMs);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(expiry));
  return `${expiry}.${toHex(sig)}`;
}

export async function verifyToken(token, secret) {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const expiry = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(expiry) || Number(expiry) < Date.now()) return false;
  const expected = toHex(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(expiry)));
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
