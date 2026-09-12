import sys
import base64
import secrets
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def encrypt_file(key_b64, src_path):
    key = base64.b64decode(key_b64)
    if len(key) != 32:
        raise ValueError("鍵は32バイトのバイナリをbase64エンコードしたものである必要があります")

    with open(src_path, "rb") as f:
        plaintext = f.read()

    nonce = secrets.token_bytes(12)
    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(nonce, plaintext, None)

    out_path = src_path + ".enc"
    with open(out_path, "wb") as f:
        f.write(nonce + ciphertext)

    print(f"Encrypted: {out_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python encrypt_kasc.py <base64-key> <path/to/kasugai_canvas.kasc>")
        sys.exit(1)

    encrypt_file(sys.argv[1], sys.argv[2])
