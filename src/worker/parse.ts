export type UserWorkKind = "illusts" | "manga" | "novels";

export type ParsedLink =
  | { kind: "illust"; id: string; unlisted: boolean }
  | { kind: "novel"; id: string; unlisted: boolean }
  | { kind: "novel_series"; id: string }
  | { kind: "manga_series"; id: string }
  | { kind: "user"; userId: string; types: UserWorkKind[] }
  | { kind: "bookmarks"; userId: string; type: "illusts" | "novels" };

export function parsePixivUrl(raw: string): ParsedLink | null {
  let text = raw.trim();
  if (!text) return null;

  try {
    if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
    const u = new URL(text);
    const host = u.hostname.replace(/^www\./, "");
    if (!host.endsWith("pixiv.net") && host !== "pixiv.me") return null;

    const path = u.pathname.replace(/\/+$/, "");

    let m = path.match(/\/artworks\/unlisted\/([A-Za-z0-9]+)/i);
    if (m) return { kind: "illust", id: m[1], unlisted: true };

    m = path.match(/\/artworks\/(\d+)/i) || path.match(/\/i\/(\d+)$/i);
    if (m) return { kind: "illust", id: m[1], unlisted: false };

    const illustQ = u.searchParams.get("illust_id");
    if (illustQ && /^\d+$/.test(illustQ)) return { kind: "illust", id: illustQ, unlisted: false };

    m = path.match(/\/novel\/unlisted\/([A-Za-z0-9]+)/i);
    if (m) return { kind: "novel", id: m[1], unlisted: true };

    m = path.match(/\/novel\/series\/(\d+)/i);
    if (m) return { kind: "novel_series", id: m[1] };

    if (path.includes("/novel/show.php")) {
      const id = u.searchParams.get("id");
      if (id && /^\d+$/.test(id)) return { kind: "novel", id, unlisted: false };
    }

    m = path.match(/\/novel\/(\d+)$/i);
    if (m) return { kind: "novel", id: m[1], unlisted: false };

    m = path.match(/\/users?\/(\d+)\/series\/(\d+)/i);
    if (m) return { kind: "manga_series", id: m[2] };

    m = path.match(/\/users?\/(\d+)\/bookmarks\/novels/i);
    if (m) return { kind: "bookmarks", userId: m[1], type: "novels" };

    m = path.match(/\/users?\/(\d+)\/bookmarks/i);
    if (m) return { kind: "bookmarks", userId: m[1], type: "illusts" };

    m = path.match(/\/users?\/(\d+)(\/.+)?$/i);
    if (m) {
      const rest = m[2] || "";
      let types: UserWorkKind[] = ["illusts", "manga", "novels"];
      if (rest.includes("/illustrations")) types = ["illusts"];
      else if (rest.includes("/manga")) types = ["manga"];
      else if (rest.includes("/novels")) types = ["novels"];
      else if (rest.includes("/artworks")) types = ["illusts", "manga"];
      return { kind: "user", userId: m[1], types };
    }

    return null;
  } catch {
    const digits = text.match(/artworks\/(\d+)/i) || text.match(/novel\/show\.php\?id=(\d+)/i);
    if (digits) {
      return text.includes("novel")
        ? { kind: "novel", id: digits[1], unlisted: false }
        : { kind: "illust", id: digits[1], unlisted: false };
    }
    return null;
  }
}

export function safeFilename(name: string, fallback = "file"): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replaceAll('"', "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Powerful Pixiv Downloader: 多页原图由 p0 URL 替换页码得到。 */
export function originalPageUrl(original: string, index: number): string {
  if (index === 0) return original;
  if (original.includes("_p0")) return original.replace("_p0", `_p${index}`);
  return original.replace(/(\.\w+)$/, `_p${index}$1`);
}
