/** 按空行 / [newpage] 切小说，供阅读器与按段翻译使用。 */
export function splitNovelParagraphs(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  return normalized
    .split(/(?:\n[ \t]*\n+)|(?:\[newpage\])/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function chatCompletionsUrl(base: string): string {
  const u = base.trim().replace(/\/+$/, "");
  if (!u) return "";
  if (u.endsWith("/chat/completions")) return u;
  return `${u}/chat/completions`;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
