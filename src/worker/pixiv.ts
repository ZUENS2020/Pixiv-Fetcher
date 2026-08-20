import { browserFetchPixivJson, isCloudflareBlocked as browserCfBlocked } from "./browser-fetch";
import {
  buildPixivCookieHeader,
  DEFAULT_UA,
  PIXIV_REFERER,
  userIdFromSess,
} from "./cookie-parse";
import type { Env } from "./env";
import { rateLimit } from "./rate-limit";

export class PixivError extends Error {
  status: number;
  code: "auth" | "not_found" | "rate" | "upstream";
  constructor(message: string, status: number, code: PixivError["code"]) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type PixivClient = {
  env?: Env;
  phpSessId?: string;
  cookieHeader?: string;
  userAgent?: string;
  request: Request;
};

type AjaxEnvelope<T> = { error: boolean; message?: string; body: T };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pixivCookieHeader(client: PixivClient): string | undefined {
  if (client.cookieHeader) return client.cookieHeader;
  if (client.phpSessId) return buildPixivCookieHeader(client.phpSessId, client.phpSessId);
  return undefined;
}

export function pixivHeaders(client: PixivClient): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": client.userAgent || DEFAULT_UA,
    Referer: PIXIV_REFERER,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7",
    Accept: "application/json",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
  const cookie = pixivCookieHeader(client);
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function authErrorMessage(status: number, body: string, browserTried = false): string {
  if (isCloudflareBlocked(body) || browserCfBlocked(body)) {
    if (browserTried) {
      return "Pixiv 仍拦截远程浏览器。请在 Cloudflare Dashboard → Workers → Browser Rendering 确认已开启，或稍后重试";
    }
    return "Pixiv 的 Cloudflare 防护拦截了 Worker 直连，正在尝试远程浏览器…";
  }
  if (status === 403) {
    return "Pixiv 拒绝访问（403）：请确认 PHPSESSID 未过期";
  }
  return "Pixiv 拒绝访问，登录态可能已失效";
}

export function isCloudflareBlocked(body: string): boolean {
  return browserCfBlocked(body);
}

function parseAjaxBody<T>(text: string): T {
  const data = JSON.parse(text) as AjaxEnvelope<unknown>;
  if (data.error) {
    const msg = data.message || "Pixiv 接口错误";
    const auth =
      /login|auth|登录|許可|permission/i.test(msg) || msg.includes("ログイン");
    throw new PixivError(msg, auth ? 401 : 400, auth ? "auth" : "upstream");
  }
  return data.body as T;
}

async function browserFetchPixiv(
  client: PixivClient,
  url: string,
  format: "json" | "raw",
): Promise<Response | unknown> {
  const browser = client.env?.MYBROWSER;
  const cookie = pixivCookieHeader(client);
  if (!browser || !cookie) {
    throw new PixivError("Pixiv 直连被拦截，且未配置 Browser Rendering", 403, "auth");
  }
  try {
    const body = await browserFetchPixivJson(
      browser,
      url,
      cookie,
      client.userAgent || DEFAULT_UA,
    );
    if (format === "raw") {
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return body;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Browser Rendering 失败";
    throw new PixivError(msg, 403, "auth");
  }
}

async function relayFetchPixiv(
  client: PixivClient,
  url: string,
  format: "json" | "raw",
): Promise<Response | unknown> {
  const relayBase = client.env?.PIXIV_RELAY_URL?.replace(/\/$/, "");
  const secret = client.env?.PIXIV_RELAY_SECRET;
  const cookie = pixivCookieHeader(client);
  if (!relayBase || !secret || !cookie) {
    throw new PixivError("未配置 Pixiv 中继（PIXIV_RELAY_URL / PIXIV_RELAY_SECRET）", 503, "upstream");
  }
  const res = await fetch(`${relayBase}/forward`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({
      url,
      cookie,
      userAgent: client.userAgent || DEFAULT_UA,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `Pixiv 中继返回 ${res.status}`;
    try {
      const data = JSON.parse(text) as { error?: string };
      if (data.error) msg = data.error;
    } catch {
      /* ignore */
    }
    throw new PixivError(msg, res.status, "upstream");
  }
  if (format === "raw") return new Response(text, { status: 200 });
  return parseAjaxBody(text);
}

/**
 * 对齐 Powerful Pixiv Downloader 的 API.fetch：
 * 429 自动等待重试；502 最多重试 3 次。
 */
async function fetchPixiv(
  client: PixivClient,
  url: string,
  format: "json" | "raw" = "json",
): Promise<Response | unknown> {
  const ok = await rateLimit(client.request, "pixiv-ajax", 40, 60);
  if (!ok) {
    throw new PixivError("请求过于频繁，请稍后再试", 429, "rate");
  }

  // Pixiv 会拦截 Cloudflare 机房 IP：优先走自建中继，其次远程浏览器，最后直连
  if (client.env?.PIXIV_RELAY_URL && pixivCookieHeader(client)) {
    return relayFetchPixiv(client, url, format);
  }
  if (client.env?.MYBROWSER && pixivCookieHeader(client)) {
    return browserFetchPixiv(client, url, format);
  }

  let tryCount = 0;
  let browserTried = false;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, { headers: pixivHeaders(client) });
    } catch {
      throw new PixivError("无法连接 Pixiv，请稍后重试", 502, "upstream");
    }
    if (res.ok) {
      if (format === "raw") return res;
      const text = await res.text();
      return parseAjaxBody(text);
    }

    if (res.status === 429) {
      if (tryCount >= 8) {
        throw new PixivError("Pixiv 限流，请稍后再试", 429, "rate");
      }
      tryCount += 1;
      await sleep(15_000);
      continue;
    }
    if (res.status === 502 && tryCount < 3) {
      tryCount += 1;
      await sleep(3_000);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      const body = await res.text();
      if (isCloudflareBlocked(body) && !browserTried) {
        browserTried = true;
        return browserFetchPixiv(client, url, format);
      }
      throw new PixivError(authErrorMessage(res.status, body, browserTried), res.status, "auth");
    }
    if (res.status === 404) {
      throw new PixivError("作品不存在或已删除", 404, "not_found");
    }
    throw new PixivError(`Pixiv 返回 ${res.status}`, res.status, "upstream");
  }
}

async function ajax<T>(client: PixivClient, path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `https://www.pixiv.net${path}`;
  return (await fetchPixiv(client, url, "json")) as T;
}

type UserProfileBody = {
  name?: string;
  userName?: string;
  isLogin?: boolean;
  userId?: string | number;
};

export async function validateSession(
  client: PixivClient,
): Promise<{ userId: string; userName: string }> {
  const userId = userIdFromSess(client.phpSessId || "");
  if (!userId) {
    throw new PixivError("无法从 PHPSESSID 解析用户 ID", 400, "auth");
  }

  let userName = `uid:${userId}`;
  try {
    const user = await ajax<UserProfileBody>(client, `/ajax/user/${userId}?full=1`);
    userName = user.name || user.userName || userName;
    if (user.isLogin === true) {
      return { userId, userName };
    }
  } catch (err) {
    if (err instanceof PixivError && err.code !== "auth") throw err;
  }

  // 备用：部分账号 profile 不暴露 isLogin，再试仅登录可用的接口
  await ajax<unknown>(client, "/ajax/user/extra");
  return { userId, userName };
}

export type IllustBody = {
  id: string;
  title: string;
  userId: string;
  userName: string;
  illustType: number;
  pageCount: number;
  xRestrict: number;
  sl?: number;
  tags?: { tags?: Array<{ tag: string }> };
  urls?: { original?: string | null; regular?: string | null; small?: string; thumb?: string };
  description?: string;
  seriesNavData?: { seriesId?: number | string; title?: string; order?: number } | null;
  createDate?: string;
};

export async function getIllust(
  client: PixivClient,
  id: string,
  unlisted = false,
): Promise<IllustBody> {
  const prefix = unlisted ? "unlisted/" : "";
  return ajax<IllustBody>(client, `/ajax/illust/${prefix}${id}?time=${Date.now()}`);
}

export type UgoiraMeta = {
  src?: string;
  originalSrc?: string;
  mime_type?: string;
  frames: Array<{ file: string; delay: number }>;
};

export async function getUgoiraMeta(client: PixivClient, id: string): Promise<UgoiraMeta> {
  return ajax<UgoiraMeta>(client, `/ajax/illust/${id}/ugoira_meta`);
}

export type NovelBody = {
  id: string;
  title: string;
  userId: string;
  userName: string;
  content: string;
  description?: string;
  xRestrict?: number;
  tags?: { tags?: Array<{ tag: string }> };
  coverUrl?: string;
  seriesNavData?: { seriesId?: number; title?: string; order?: number } | null;
};

export async function getNovel(
  client: PixivClient,
  id: string,
  unlisted = false,
): Promise<NovelBody> {
  const prefix = unlisted ? "unlisted/" : "";
  return ajax<NovelBody>(client, `/ajax/novel/${prefix}${id}?time=${Date.now()}`);
}

export type NovelSeriesBody = {
  title?: string;
  userName?: string;
  userId?: string;
  displaySeriesContentCount?: number;
};

export async function getNovelSeries(client: PixivClient, id: string): Promise<NovelSeriesBody> {
  return ajax<NovelSeriesBody>(client, `/ajax/novel/series/${id}`);
}

export async function getNovelSeriesContent(
  client: PixivClient,
  id: string,
  lastOrder = 0,
  limit = 30,
): Promise<{
  page?: { seriesContents?: Array<{ id: string; title?: string }> };
  thumbnails?: { novel?: Array<{ id: string; title: string }> };
}> {
  return ajax(
    client,
    `/ajax/novel/series_content/${id}?limit=${limit}&last_order=${lastOrder}&order_by=asc`,
  );
}

export type MangaSeriesBody = {
  page?: {
    series?: Array<{ workId?: number | string; order?: number }>;
  };
  thumbnails?: { illust?: Array<{ id: string; title: string; url?: string; userName?: string }> };
  illustSeries?: Array<{ title?: string; userName?: string }>;
};

export async function getMangaSeries(
  client: PixivClient,
  id: string,
  page = 1,
): Promise<MangaSeriesBody> {
  return ajax<MangaSeriesBody>(client, `/ajax/series/${id}?p=${page}`);
}

export async function getUserProfile(
  client: PixivClient,
  userId: string,
): Promise<{ name?: string; userName?: string }> {
  return ajax(client, `/ajax/user/${userId}?full=1`);
}

export type UserWorkId = { type: "illusts" | "manga" | "novels"; id: string };

/** `/ajax/user/{id}/profile/all` 一次返回该用户全部作品 id。 */
export async function getUserWorksByType(
  client: PixivClient,
  userId: string,
  types: Array<"illusts" | "manga" | "novels">,
): Promise<UserWorkId[]> {
  const data = await ajax<{
    illusts?: Record<string, unknown> | null;
    manga?: Record<string, unknown> | null;
    novels?: Record<string, unknown> | null;
  }>(client, `/ajax/user/${userId}/profile/all`);
  const out: UserWorkId[] = [];
  for (const type of types) {
    const bag = data[type];
    if (!bag || typeof bag !== "object") continue;
    for (const id of Object.keys(bag)) {
      out.push({ type, id });
    }
  }
  out.sort((a, b) => Number(b.id) - Number(a.id));
  return out;
}

export async function getBookmarkIds(
  client: PixivClient,
  userId: string,
  type: "illusts" | "novels",
  max = 300,
): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; offset < max; offset += 100) {
    const data = await ajax<{
      works?: Array<{ id?: string | number }>;
    }>(
      client,
      `/ajax/user/${userId}/${type}/bookmarks?tag=&offset=${offset}&limit=100&rest=show`,
    );
    const chunk = (data.works || []).map((w) => String(w.id)).filter(Boolean);
    if (!chunk.length) break;
    ids.push(...chunk);
    if (chunk.length < 100) break;
  }
  return ids;
}

export async function fetchPixivAsset(url: string, userAgent?: string): Promise<Response> {
  let tryCount = 0;
  for (;;) {
    const res = await fetch(url, {
      headers: {
        Referer: PIXIV_REFERER,
        "User-Agent": userAgent || DEFAULT_UA,
      },
    });
    if (res.ok) return res;
    if (res.status === 429 && tryCount < 8) {
      tryCount += 1;
      await sleep(15_000);
      continue;
    }
    if (res.status === 502 && tryCount < 3) {
      tryCount += 1;
      await sleep(3_000);
      continue;
    }
    throw new PixivError(`资源下载失败 ${res.status}`, res.status, "upstream");
  }
}

export function allowedAssetHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "i.pximg.net" || host === "s.pximg.net" || host.endsWith(".pximg.net");
  } catch {
    return false;
  }
}
