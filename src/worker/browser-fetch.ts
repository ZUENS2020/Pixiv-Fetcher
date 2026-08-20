import puppeteer from "@cloudflare/puppeteer";
import type { BrowserWorker } from "@cloudflare/puppeteer";

function parseCookiePairs(cookieHeader: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out.push({ name, value });
  }
  return out;
}

export function isCloudflareBlocked(body: string): boolean {
  return /just a moment|cf-browser-verification|challenge-platform|cloudflare/i.test(body);
}

function parseAjaxEnvelope(text: string): unknown | null {
  try {
    const data = JSON.parse(text) as { error?: boolean; body?: unknown; message?: string };
    if (!data.error && data.body !== undefined) return data.body;
    if (data.error && data.message) throw new Error(data.message);
  } catch (err) {
    if (err instanceof Error && err.message && !err.message.startsWith("Unexpected")) throw err;
  }
  return null;
}

function looksLikeWork(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.title === "string" && Boolean(rec.id || rec.novelId || rec.illustId);
}

function normalizeAjaxWork(raw: unknown, ajaxUrl: string): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const rec = raw as Record<string, unknown>;
  const idMatch = ajaxUrl.match(/\/(\d+)(?:\?|$)/);
  const fallbackId = idMatch?.[1] || "";
  if (!looksLikeWork(rec)) return raw;
  const author = rec.author as { id?: number | string; name?: string } | undefined;
  return {
    ...rec,
    id: String(rec.id ?? rec.novelId ?? rec.illustId ?? fallbackId),
    userId: String(rec.userId ?? rec.user_id ?? author?.id ?? ""),
    userName: String(rec.userName ?? rec.user_name ?? author?.name ?? ""),
    content: rec.content ?? rec.description ?? "",
    xRestrict: rec.xRestrict ?? rec.x_restrict ?? 0,
    coverUrl:
      rec.coverUrl ??
      rec.cover_url ??
      (rec.cover as { urls?: { original?: string } } | undefined)?.urls?.original,
  };
}

async function applyCookies(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>,
  cookieHeader: string,
): Promise<void> {
  for (const { name, value } of parseCookiePairs(cookieHeader)) {
    await page.setCookie({
      name,
      value,
      domain: ".pixiv.net",
      path: "/",
      secure: true,
      httpOnly: name === "PHPSESSID",
    });
  }
}

/** 在 Cloudflare 远程 Chrome 中携带 Cookie 请求 Pixiv Ajax。 */
export async function browserFetchPixivJson(
  browserBinding: BrowserWorker,
  ajaxUrl: string,
  cookieHeader: string,
  userAgent: string,
): Promise<unknown> {
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(userAgent);
    await page.setExtraHTTPHeaders({
      Accept: "application/json",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7",
      Referer: "https://www.pixiv.net/",
    });

    await page.goto("https://www.pixiv.net/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await applyCookies(page, cookieHeader);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });

    const response = await page.goto(ajaxUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    const status = response?.status() ?? 0;
    const text = (await response?.text()) ?? "";

    if (status === 200) {
      const body = parseAjaxEnvelope(text);
      if (body) return normalizeAjaxWork(body, ajaxUrl);
    }

    if (isCloudflareBlocked(text)) {
      throw new Error("远程浏览器仍被 Pixiv Cloudflare 拦截，请稍后重试");
    }
    if (status === 401 || status === 403) {
      throw new Error("PHPSESSID 在远程浏览器中无效或已过期，请重新录入");
    }
    throw new Error(`远程浏览器请求 Pixiv 失败（HTTP ${status || "unknown"}）`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/quota|limit|not enabled|browser/i.test(msg)) {
      throw new Error(`Browser Rendering 不可用：${msg}`);
    }
    throw err instanceof Error ? err : new Error(msg);
  } finally {
    await browser.close();
  }
}
