import { downloadZip } from "client-zip";
import { DEFAULT_UA } from "./cookie-parse";
import type { Env } from "./env";
import {
  allowedAssetHost,
  fetchPixivAsset,
  getBookmarkIds,
  getIllust,
  getMangaSeries,
  getNovel,
  getNovelSeries,
  getNovelSeriesContent,
  getUgoiraMeta,
  getUserProfile,
  getUserWorksByType,
  PixivError,
  type IllustBody,
  type PixivClient,
  validateSession,
} from "./pixiv";
import { contentDisposition, firstPixivUrl, originalPageUrl, parsePixivUrl, safeFilename, type ParsedLink } from "./parse";
import {
  getArtworkWork,
  getObject,
  getWorkById,
  getWorkByPixiv,
  insertCrawlJob,
  listFiles,
  mimeFromName,
  objectSize,
  pixivUrlForWork,
  putBytes,
  r2Prefix,
  refreshWorkStats,
  upsertFile,
  upsertWork,
  type WorkKind,
  type WorkRow,
} from "./store";

export const MAX_BATCH = 80;

export type Preview = {
  kind: string;
  id: string;
  title: string;
  author: string;
  authorId: string;
  pageCount: number;
  xRestrict: number;
  tags: string[];
  thumb: string | null;
  needLogin: boolean;
  cached?: boolean;
};

export type CrawlResult = {
  title: string;
  count: number;
  complete: number;
  restricted: number;
  works: Array<{
    id: number;
    pixivId: string;
    kind: string;
    title: string;
    complete: boolean;
    restricted: boolean;
  }>;
};

type ZipEntry = { name: string; input: Blob | Response | string };

function tagsOf(tags?: { tags?: Array<{ tag: string }> }): string[] {
  return (tags?.tags || []).map((t) => t.tag).filter(Boolean);
}

function novelToText(novel: {
  id: string;
  title: string;
  userName: string;
  userId: string;
  content: string;
  tags?: { tags?: Array<{ tag: string }> };
}): string {
  const tags = tagsOf(novel.tags).join(", ");
  const body = novel.content
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<rp>.*?<\/rp>/gi, "")
    .replace(/<rt>.*?<\/rt>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[uploadedimage:\d+\]/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return [
    novel.title,
    `作者: ${novel.userName} (${novel.userId})`,
    `链接: https://www.pixiv.net/novel/show.php?id=${novel.id}`,
    tags ? `标签: ${tags}` : "",
    "",
    body,
    "",
  ]
    .filter((line, i, arr) => line !== "" || arr[i - 1] !== "")
    .join("\n");
}

function extFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.(jpg|jpeg|png|gif|webp)$/i);
    return m ? m[1].toLowerCase() : "jpg";
  } catch {
    return "jpg";
  }
}

function artworkKind(illust: IllustBody): WorkKind {
  if (illust.illustType === 2) return "ugoira";
  if ((illust.pageCount || 1) > 1 || illust.illustType === 1) return "manga";
  return "illust";
}

function clientFromSess(
  env: Env,
  request: Request,
  sess: { phpSessId: string; cookieHeader?: string; userAgent?: string } | null,
): PixivClient {
  return {
    env,
    request,
    phpSessId: sess?.phpSessId,
    cookieHeader: sess?.cookieHeader,
    userAgent: sess?.userAgent || DEFAULT_UA,
  };
}

function slimMeta(body: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(body, (key, value) => {
      if (key === "content" && typeof value === "string" && value.length > 2000) {
        return `${value.slice(0, 2000)}…`;
      }
      return value;
    }));
  } catch {
    return null;
  }
}

async function ensureR2File(
  env: Env,
  work: WorkRow,
  pageIndex: number,
  filename: string,
  key: string,
  contentType: string,
  fetcher: () => ArrayBuffer | Uint8Array | string | Promise<ArrayBuffer | Uint8Array | string>,
): Promise<void> {
  const existing = await objectSize(env, key);
  if (existing != null) {
    await upsertFile(env, work.id, pageIndex, filename, key, contentType, existing);
    return;
  }
  const bytes = await fetcher();
  const size = await putBytes(env, key, bytes, contentType);
  await upsertFile(env, work.id, pageIndex, filename, key, contentType, size);
}

async function fetchAssetBytes(url: string, userAgent?: string): Promise<ArrayBuffer> {
  const res = await fetchPixivAsset(url, userAgent);
  return res.arrayBuffer();
}

export async function cacheIllust(
  env: Env,
  client: PixivClient,
  id: string,
  unlisted: boolean,
  sourceUrl: string,
): Promise<WorkRow> {
  const existing = await getArtworkWork(env, id);
  if (existing?.complete && !existing.restricted) return existing;

  const illust = await getIllust(client, id, unlisted);
  const kind = artworkKind(illust);
  const original = illust.urls?.original || null;
  const restricted = original == null && kind !== "ugoira";
  const work = await upsertWork(env, {
    pixiv_id: String(illust.id),
    kind,
    title: illust.title,
    author: illust.userName,
    user_id: String(illust.userId),
    page_count: illust.pageCount || 1,
    x_restrict: illust.xRestrict || 0,
    sl: illust.sl ?? null,
    restricted: restricted ? 1 : 0,
    source_url: sourceUrl,
    thumb_url: illust.urls?.regular || illust.urls?.small || illust.urls?.thumb || null,
    tags: tagsOf(illust.tags),
    meta: slimMeta(illust),
  });

  if (restricted) {
    return refreshWorkStats(env, work.id, 1, true);
  }

  const prefix = work.r2_prefix || r2Prefix(kind, String(illust.id));
  const base = safeFilename(illust.title, String(illust.id));

  if (kind === "ugoira") {
    const meta = await getUgoiraMeta(client, id);
    const zipUrl = meta.originalSrc || meta.src;
    if (!zipUrl) throw new PixivError("找不到动图资源", 404, "not_found");
    await ensureR2File(env, work, 0, `${id}_ugoira.zip`, `${prefix}ugoira.zip`, "application/zip", () =>
      fetchAssetBytes(zipUrl, client.userAgent),
    );
    await ensureR2File(
      env,
      work,
      1,
      "animation.json",
      `${prefix}animation.json`,
      "application/json",
      () => JSON.stringify(meta, null, 2),
    );
    return refreshWorkStats(env, work.id, 2);
  }

  const pages = illust.pageCount || 1;
  if (!original) throw new PixivError("找不到原图", 404, "not_found");
  for (let i = 0; i < pages; i++) {
    const url = originalPageUrl(original, i);
    const ext = extFromUrl(url);
    const filename = `${base}_p${i}.${ext}`;
    await ensureR2File(env, work, i, filename, `${prefix}p${i}.${ext}`, mimeFromName(filename), () =>
      fetchAssetBytes(url, client.userAgent),
    );
  }
  return refreshWorkStats(env, work.id, pages);
}

export async function cacheNovel(
  env: Env,
  client: PixivClient,
  id: string,
  unlisted: boolean,
  sourceUrl: string,
): Promise<WorkRow> {
  const existing = await getWorkByPixiv(env, id, "novel");
  if (existing?.complete && !existing.restricted) return existing;

  const novel = await getNovel(client, id, unlisted);
  const work = await upsertWork(env, {
    pixiv_id: String(novel.id),
    kind: "novel",
    title: novel.title,
    author: novel.userName,
    user_id: String(novel.userId),
    page_count: 1,
    x_restrict: novel.xRestrict || 0,
    sl: null,
    restricted: 0,
    source_url: sourceUrl,
    thumb_url: novel.coverUrl || null,
    tags: tagsOf(novel.tags),
    meta: slimMeta({ ...novel, content: undefined }),
  });
  const prefix = work.r2_prefix || r2Prefix("novel", String(novel.id));
  const filename = `${safeFilename(novel.title, novel.id)}.txt`;
  await ensureR2File(env, work, 0, filename, `${prefix}novel.txt`, "text/plain; charset=utf-8", () =>
    novelToText(novel),
  );
  return refreshWorkStats(env, work.id, 1);
}

async function collectNovelSeriesIds(client: PixivClient, id: string): Promise<string[]> {
  const ids: string[] = [];
  let last = 0;
  for (let i = 0; i < 40; i++) {
    const page = await getNovelSeriesContent(client, id, last, 30);
    const items =
      page.page?.seriesContents?.map((x) => x.id) || page.thumbnails?.novel?.map((x) => x.id) || [];
    if (!items.length) break;
    ids.push(...items);
    last += items.length;
    if (items.length < 30) break;
    if (ids.length >= MAX_BATCH) break;
  }
  return ids.slice(0, MAX_BATCH);
}

/** Powerful Pixiv Downloader：漫画系列以 `page.series.length === 0` 结束。 */
async function collectMangaSeriesIds(client: PixivClient, id: string): Promise<string[]> {
  const ids: string[] = [];
  for (let p = 1; p <= 50; p++) {
    const page = await getMangaSeries(client, id, p);
    const series = page.page?.series || [];
    if (!series.length) break;
    for (const item of series) {
      const wid = String(item.workId || "");
      if (wid) ids.push(wid);
    }
    if (ids.length >= MAX_BATCH) break;
  }
  return [...new Set(ids)].slice(0, MAX_BATCH);
}

async function cacheOneSafe(
  fn: () => Promise<WorkRow>,
): Promise<{ work?: WorkRow; skipped?: string }> {
  try {
    return { work: await fn() };
  } catch (err) {
    if (err instanceof PixivError && (err.code === "not_found" || err.code === "auth")) {
      return { skipped: err.message };
    }
    throw err;
  }
}

async function cacheParsed(
  env: Env,
  client: PixivClient,
  parsed: ParsedLink,
  sourceUrl: string,
): Promise<{ title: string; works: WorkRow[] }> {
  if (parsed.kind === "illust") {
    const work = await cacheIllust(env, client, parsed.id, parsed.unlisted, sourceUrl);
    return { title: work.title, works: [work] };
  }
  if (parsed.kind === "novel") {
    const work = await cacheNovel(env, client, parsed.id, parsed.unlisted, sourceUrl);
    return { title: work.title, works: [work] };
  }

  const works: WorkRow[] = [];

  if (parsed.kind === "novel_series") {
    const series = await getNovelSeries(client, parsed.id);
    const ids = await collectNovelSeriesIds(client, parsed.id);
    for (const nid of ids) {
      const one = await cacheOneSafe(() => cacheNovel(env, client, nid, false, sourceUrl));
      if (one.work) works.push(one.work);
    }
    return { title: series.title || `小说系列 ${parsed.id}`, works };
  }

  if (parsed.kind === "manga_series") {
    const first = await getMangaSeries(client, parsed.id, 1);
    const title = first.illustSeries?.[0]?.title || `漫画系列 ${parsed.id}`;
    const ids = await collectMangaSeriesIds(client, parsed.id);
    for (const iid of ids) {
      const one = await cacheOneSafe(() => cacheIllust(env, client, iid, false, sourceUrl));
      if (one.work) works.push(one.work);
    }
    return { title, works };
  }

  if (parsed.kind === "user") {
    const profile = await getUserProfile(client, parsed.userId);
    const ids = (await getUserWorksByType(client, parsed.userId, parsed.types)).slice(0, MAX_BATCH);
    for (const item of ids) {
      const one =
        item.type === "novels"
          ? await cacheOneSafe(() => cacheNovel(env, client, item.id, false, sourceUrl))
          : await cacheOneSafe(() => cacheIllust(env, client, item.id, false, sourceUrl));
      if (one.work) works.push(one.work);
    }
    return { title: profile.name || profile.userName || `用户 ${parsed.userId}`, works };
  }

  const ids = (await getBookmarkIds(client, parsed.userId, parsed.type, MAX_BATCH)).slice(0, MAX_BATCH);
  for (const bid of ids) {
    const one =
      parsed.type === "novels"
        ? await cacheOneSafe(() => cacheNovel(env, client, bid, false, sourceUrl))
        : await cacheOneSafe(() => cacheIllust(env, client, bid, false, sourceUrl));
    if (one.work) works.push(one.work);
  }
  return { title: `收藏 ${parsed.userId}`, works };
}

function crawlSummary(title: string, works: WorkRow[]): CrawlResult {
  return {
    title,
    count: works.length,
    complete: works.filter((w) => w.complete).length,
    restricted: works.filter((w) => w.restricted).length,
    works: works.map((w) => ({
      id: w.id,
      pixivId: w.pixiv_id,
      kind: w.kind,
      title: w.title,
      complete: Boolean(w.complete),
      restricted: Boolean(w.restricted),
    })),
  };
}

export async function crawlUrl(
  env: Env,
  request: Request,
  sess: { phpSessId: string; cookieHeader?: string; userAgent?: string } | null,
  rawUrl: string,
): Promise<CrawlResult> {
  const url = firstPixivUrl(rawUrl);
  const parsed = url ? parsePixivUrl(url) : parsePixivUrl(rawUrl);
  if (!parsed) throw new PixivError("无法识别的 Pixiv 链接", 400, "upstream");
  const source = url || rawUrl.trim();
  const client = clientFromSess(env, request, sess);
  const { title, works } = await cacheParsed(env, client, parsed, source);
  if (!works.length) throw new PixivError("没有抓到可保存的作品", 404, "not_found");
  await insertCrawlJob(env, source, parsed.kind, works.length, "ok");
  return crawlSummary(title, works);
}

async function r2Response(env: Env, key: string): Promise<Response> {
  const obj = await getObject(env, key);
  if (!obj) throw new PixivError("缓存文件缺失，请重新抓取", 404, "not_found");
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
    },
  });
}

async function* zipWorkEntries(env: Env, work: WorkRow, folder = ""): AsyncGenerator<ZipEntry> {
  const files = await listFiles(env, work.id);
  const prefix = folder ? `${folder}/` : "";
  yield {
    name: `${prefix}info.json`,
    input: JSON.stringify(
      {
        id: work.pixiv_id,
        title: work.title,
        userName: work.author,
        userId: work.user_id,
        kind: work.kind,
        tags: JSON.parse(work.tags_json || "[]"),
        url: pixivUrlForWork(work),
      },
      null,
      2,
    ),
  };
  for (const file of files) {
    yield { name: `${prefix}${file.filename}`, input: await r2Response(env, file.r2_key) };
  }
}

async function serveWork(env: Env, work: WorkRow): Promise<Response> {
  if (work.restricted) {
    throw new PixivError("作品受限制（年龄限制或未登录），无法获取原图", 401, "auth");
  }
  if (!work.complete) {
    throw new PixivError("作品尚未抓取完整，请先抓取入库", 409, "upstream");
  }
  const files = await listFiles(env, work.id);
  if (!files.length) throw new PixivError("缓存文件缺失，请重新抓取", 404, "not_found");

  if (work.kind === "novel" && files.length === 1) {
    const obj = await getObject(env, files[0].r2_key);
    if (!obj) throw new PixivError("缓存文件缺失，请重新抓取", 404, "not_found");
    return new Response(obj.body, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": contentDisposition(files[0].filename),
      },
    });
  }

  if (work.kind !== "ugoira" && work.page_count === 1 && files.length === 1) {
    const obj = await getObject(env, files[0].r2_key);
    if (!obj) throw new PixivError("缓存文件缺失，请重新抓取", 404, "not_found");
    return new Response(obj.body, {
      headers: {
        "Content-Type": files[0].content_type || obj.httpMetadata?.contentType || "image/jpeg",
        "Content-Disposition": contentDisposition(files[0].filename),
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  const zipName = `${work.pixiv_id}_${safeFilename(work.title)}.zip`;
  const zip = downloadZip(zipWorkEntries(env, work));
  return new Response(zip.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(zipName),
    },
  });
}

async function serveWorksZip(env: Env, title: string, id: string, works: WorkRow[]): Promise<Response> {
  const ready = works.filter((w) => w.complete && !w.restricted);
  if (!ready.length) throw new PixivError("没有可下载的已缓存作品", 404, "not_found");
  async function* entries(): AsyncGenerator<ZipEntry> {
    yield {
      name: "info.json",
      input: JSON.stringify({ id, title, count: ready.length }, null, 2),
    };
    let n = 1;
    for (const work of ready) {
      const folder = `${String(n).padStart(3, "0")}_${safeFilename(work.title, work.pixiv_id)}`;
      yield* zipWorkEntries(env, work, folder);
      n += 1;
    }
  }
  const zip = downloadZip(entries());
  return new Response(zip.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(`${id}_${safeFilename(title)}.zip`),
    },
  });
}

export async function downloadWork(
  env: Env,
  request: Request,
  sess: { phpSessId: string; cookieHeader?: string; userAgent?: string } | null,
  rawUrl: string,
): Promise<Response> {
  const url = firstPixivUrl(rawUrl);
  const parsed = url ? parsePixivUrl(url) : parsePixivUrl(rawUrl);
  if (!parsed) throw new PixivError("无法识别的 Pixiv 链接", 400, "upstream");
  const source = url || rawUrl.trim();
  const client = clientFromSess(env, request, sess);
  const { title, works } = await cacheParsed(env, client, parsed, source);
  if (!works.length) throw new PixivError("没有抓到可保存的作品", 404, "not_found");
  await insertCrawlJob(env, source, parsed.kind, works.length, "ok");
  if (works.length === 1) return serveWork(env, works[0]);
  const zipId =
    parsed.kind === "user" || parsed.kind === "bookmarks" ? parsed.userId : parsed.id;
  return serveWorksZip(env, title, zipId, works);
}

export async function downloadLibraryWork(
  env: Env,
  request: Request,
  sess: { phpSessId: string; cookieHeader?: string; userAgent?: string } | null,
  workId: number,
): Promise<Response> {
  let work = await getWorkById(env, workId);
  if (!work) throw new PixivError("文库中没有该作品", 404, "not_found");
  if (!work.complete || work.restricted) {
    const client = clientFromSess(env, request, sess);
    work =
      work.kind === "novel"
        ? await cacheNovel(env, client, work.pixiv_id, false, pixivUrlForWork(work))
        : await cacheIllust(env, client, work.pixiv_id, false, pixivUrlForWork(work));
  }
  return serveWork(env, work);
}

export async function previewWork(
  env: Env,
  request: Request,
  sess: { phpSessId: string; cookieHeader?: string; userAgent?: string } | null,
  rawUrl: string,
): Promise<Preview> {
  const url = firstPixivUrl(rawUrl);
  const parsed = url ? parsePixivUrl(url) : parsePixivUrl(rawUrl);
  if (!parsed) throw new PixivError("无法识别的 Pixiv 链接", 400, "upstream");
  const client = clientFromSess(env, request, sess);
  const bound = Boolean(sess?.phpSessId);
  return previewParsed(env, client, parsed, bound, url || rawUrl.trim());
}

async function previewParsed(
  env: Env,
  client: PixivClient,
  parsed: ParsedLink,
  bound: boolean,
  sourceUrl: string,
): Promise<Preview> {
  if (parsed.kind === "illust") {
    const cached = await getArtworkWork(env, parsed.id);
    const illust = await getIllust(client, parsed.id, parsed.unlisted);
    const kind = artworkKind(illust);
    await upsertWork(env, {
      pixiv_id: String(illust.id),
      kind,
      title: illust.title,
      author: illust.userName,
      user_id: String(illust.userId),
      page_count: illust.pageCount || 1,
      x_restrict: illust.xRestrict || 0,
      sl: illust.sl ?? null,
      restricted: illust.urls?.original == null && kind !== "ugoira" ? 1 : 0,
      source_url: sourceUrl,
      thumb_url: illust.urls?.regular || illust.urls?.small || illust.urls?.thumb || null,
      tags: tagsOf(illust.tags),
      meta: slimMeta(illust),
    });
    const thumb = illust.urls?.regular || illust.urls?.small || illust.urls?.thumb || null;
    return {
      kind,
      id: String(illust.id),
      title: illust.title,
      author: illust.userName,
      authorId: String(illust.userId),
      pageCount: illust.pageCount || 1,
      xRestrict: illust.xRestrict || 0,
      tags: tagsOf(illust.tags),
      thumb,
      needLogin: (illust.xRestrict || 0) > 0 && !bound,
      cached: Boolean(cached?.complete),
    };
  }

  if (parsed.kind === "novel") {
    const cached = await getWorkByPixiv(env, parsed.id, "novel");
    const novel = await getNovel(client, parsed.id, parsed.unlisted);
    await upsertWork(env, {
      pixiv_id: String(novel.id),
      kind: "novel",
      title: novel.title,
      author: novel.userName,
      user_id: String(novel.userId),
      page_count: 1,
      x_restrict: novel.xRestrict || 0,
      sl: null,
      restricted: 0,
      source_url: sourceUrl,
      thumb_url: novel.coverUrl || null,
      tags: tagsOf(novel.tags),
      meta: slimMeta({ ...novel, content: undefined }),
    });
    return {
      kind: "novel",
      id: String(novel.id),
      title: novel.title,
      author: novel.userName,
      authorId: String(novel.userId),
      pageCount: 1,
      xRestrict: novel.xRestrict || 0,
      tags: tagsOf(novel.tags),
      thumb: novel.coverUrl || null,
      needLogin: (novel.xRestrict || 0) > 0 && !bound,
      cached: Boolean(cached?.complete),
    };
  }

  if (parsed.kind === "novel_series") {
    const series = await getNovelSeries(client, parsed.id);
    const first = await getNovelSeriesContent(client, parsed.id, 0, 1);
    const n = first.thumbnails?.novel?.[0] || first.page?.seriesContents?.[0];
    let thumb: string | null = null;
    let xRestrict = 0;
    if (n?.id) {
      try {
        const novel = await getNovel(client, n.id);
        thumb = novel.coverUrl || null;
        xRestrict = novel.xRestrict || 0;
      } catch {
        /* ignore */
      }
    }
    return {
      kind: "novel_series",
      id: parsed.id,
      title: series.title || `小说系列 ${parsed.id}`,
      author: series.userName || "",
      authorId: String(series.userId || ""),
      pageCount: series.displaySeriesContentCount || 0,
      xRestrict,
      tags: [],
      thumb,
      needLogin: xRestrict > 0 && !bound,
    };
  }

  if (parsed.kind === "manga_series") {
    const series = await getMangaSeries(client, parsed.id, 1);
    const meta = series.illustSeries?.[0];
    const first = series.thumbnails?.illust?.[0];
    const count = series.page?.series?.length || series.thumbnails?.illust?.length || 0;
    return {
      kind: "manga_series",
      id: parsed.id,
      title: meta?.title || first?.title || `漫画系列 ${parsed.id}`,
      author: meta?.userName || first?.userName || "",
      authorId: "",
      pageCount: count,
      xRestrict: 0,
      tags: [],
      thumb: first?.url || null,
      needLogin: !bound,
    };
  }

  if (parsed.kind === "user") {
    const profile = await getUserProfile(client, parsed.userId);
    const ids = await getUserWorksByType(client, parsed.userId, parsed.types);
    return {
      kind: "user",
      id: parsed.userId,
      title: profile.name || profile.userName || `用户 ${parsed.userId}`,
      author: profile.name || profile.userName || "",
      authorId: parsed.userId,
      pageCount: ids.length,
      xRestrict: 0,
      tags: parsed.types,
      thumb: null,
      needLogin: !bound,
    };
  }

  const ids = await getBookmarkIds(client, parsed.userId, parsed.type, MAX_BATCH);
  return {
    kind: "bookmarks",
    id: parsed.userId,
    title: parsed.type === "novels" ? "小说收藏" : "插画收藏",
    author: parsed.userId,
    authorId: parsed.userId,
    pageCount: ids.length,
    xRestrict: 0,
    tags: [parsed.type],
    thumb: null,
    needLogin: !bound,
  };
}

export async function proxyAsset(url: string, userAgent?: string): Promise<Response> {
  if (!allowedAssetHost(url)) {
    throw new PixivError("不允许的图片域名", 400, "upstream");
  }
  const res = await fetchPixivAsset(url, userAgent);
  return new Response(res.body, {
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "image/jpeg",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

export async function serveR2File(env: Env, key: string, asDownload = false): Promise<Response> {
  const obj = await getObject(env, key);
  if (!obj) throw new PixivError("文件不存在", 404, "not_found");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", "private, max-age=86400");
  if (asDownload) {
    const name = key.split("/").pop() || "file";
    headers.set("Content-Disposition", contentDisposition(name));
  }
  return new Response(obj.body, { headers });
}

export { PixivError, validateSession };
