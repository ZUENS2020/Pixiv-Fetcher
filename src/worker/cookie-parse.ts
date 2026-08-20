export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const PIXIV_REFERER = "https://www.pixiv.net/";

export function extractPhpSessId(input: string): string | null {
  const trimmed = input.trim().replace(/^Cookie:\s*/i, "");
  const fromPair = trimmed.match(/PHPSESSID=([^;\s]+)/i);
  if (fromPair) return decodeURIComponent(fromPair[1]);
  if (/^\d+_[A-Za-z0-9]+$/.test(trimmed)) return trimmed;
  if (/^[A-Za-z0-9]{16,}$/.test(trimmed)) return trimmed;
  return null;
}

/** 从粘贴内容解析 Pixiv Cookie 头（保留 privacy_policy_agreement 等辅助项）。 */
export function buildPixivCookieHeader(input: string, phpSessId: string): string {
  const trimmed = input.trim().replace(/^Cookie:\s*/i, "");
  const pairs = new Map<string, string>();

  if (trimmed.includes("=")) {
    for (const part of trimmed.split(";")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (key) pairs.set(key, value);
    }
  }

  pairs.set("PHPSESSID", phpSessId);
  if (!pairs.has("privacy_policy_agreement")) {
    pairs.set("privacy_policy_agreement", "7");
  }

  return [...pairs.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export function userIdFromSess(phpSessId: string): string | null {
  const m = phpSessId.match(/^(\d+)_/);
  return m ? m[1] : null;
}

export function isLoggedInSess(phpSessId: string): boolean {
  return /^\d+_[A-Za-z0-9]+$/.test(phpSessId);
}
