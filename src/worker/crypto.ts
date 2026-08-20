const AAD = new TextEncoder().encode("pixiv-fetcher-v1");

async function keyFromSecret(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encryptJson(secret: string, value: unknown): Promise<string> {
  const key = await keyFromSecret(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const packed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: AAD },
    key,
    plaintext,
  );
  const ct = new Uint8Array(packed);
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64urlEncode(out);
}

export async function decryptJson<T>(secret: string, token: string): Promise<T | null> {
  try {
    const raw = b64urlDecode(token);
    if (raw.length < 13) return null;
    const iv = raw.slice(0, 12);
    const data = raw.slice(12);
    const key = await keyFromSecret(secret);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: AAD },
      key,
      data,
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null;
  }
}
