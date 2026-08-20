import type { Env } from "./env";

export type WorkKind = "illust" | "manga" | "ugoira" | "novel";

export type WorkRow = {
  id: number;
  pixiv_id: string;
  kind: WorkKind;
  title: string;
  author: string;
  user_id: string;
  page_count: number;
  x_restrict: number;
  sl: number | null;
  restricted: number;
  source_url: string;
  thumb_url: string | null;
  tags_json: string;
  meta_json: string | null;
  r2_prefix: string;
  file_count: number;
  complete: number;
  fetched_at: number;
};

export type WorkFileRow = {
  id: number;
  work_id: number;
  page_index: number;
  filename: string;
  r2_key: string;
  content_type: string;
  size: number;
};

export type WorkInput = {
  pixiv_id: string;
  kind: WorkKind;
  title: string;
  author: string;
  user_id: string;
  page_count: number;
  x_restrict: number;
  sl?: number | null;
  restricted: number;
  source_url: string;
  thumb_url?: string | null;
  tags: string[];
  meta?: unknown;
};

export function r2Prefix(kind: WorkKind, pixivId: string): string {
  return `works/${kind}/${pixivId}/`;
}

export function isSafeR2Key(key: string): boolean {
  return key.startsWith("works/") && !key.includes("..") && !key.startsWith("/");
}

export function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "zip":
      return "application/zip";
    case "txt":
      return "text/plain; charset=utf-8";
    case "json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

const WORK_COLS =
  "id, pixiv_id, kind, title, author, user_id, page_count, x_restrict, sl, restricted, source_url, thumb_url, tags_json, meta_json, r2_prefix, file_count, complete, fetched_at";

export async function getWorkById(env: Env, id: number): Promise<WorkRow | null> {
  return env.DB.prepare(`SELECT ${WORK_COLS} FROM works WHERE id = ?`).bind(id).first<WorkRow>();
}

export async function getWorkByPixiv(
  env: Env,
  pixivId: string,
  kind?: WorkKind,
): Promise<WorkRow | null> {
  if (kind) {
    return env.DB.prepare(`SELECT ${WORK_COLS} FROM works WHERE pixiv_id = ? AND kind = ?`)
      .bind(pixivId, kind)
      .first<WorkRow>();
  }
  return env.DB.prepare(`SELECT ${WORK_COLS} FROM works WHERE pixiv_id = ? ORDER BY fetched_at DESC LIMIT 1`)
    .bind(pixivId)
    .first<WorkRow>();
}

export async function getArtworkWork(env: Env, pixivId: string): Promise<WorkRow | null> {
  return env.DB.prepare(
    `SELECT ${WORK_COLS} FROM works WHERE pixiv_id = ? AND kind IN ('illust','manga','ugoira') LIMIT 1`,
  )
    .bind(pixivId)
    .first<WorkRow>();
}

export async function upsertWork(env: Env, input: WorkInput): Promise<WorkRow> {
  const prefix = r2Prefix(input.kind, input.pixiv_id);
  const now = Date.now();
  const tagsJson = JSON.stringify(input.tags || []);
  const metaJson = input.meta == null ? null : JSON.stringify(input.meta);
  const existing =
    input.kind === "novel"
      ? await getWorkByPixiv(env, input.pixiv_id, "novel")
      : await getArtworkWork(env, input.pixiv_id);

  if (existing) {
    await env.DB.prepare(
      `UPDATE works SET
         kind = ?, title = ?, author = ?, user_id = ?, page_count = ?,
         x_restrict = ?, sl = ?, restricted = ?, source_url = ?, thumb_url = ?,
         tags_json = ?, meta_json = ?, r2_prefix = ?, fetched_at = ?
       WHERE id = ?`,
    )
      .bind(
        input.kind,
        input.title,
        input.author,
        input.user_id,
        input.page_count,
        input.x_restrict,
        input.sl ?? null,
        input.restricted,
        input.source_url,
        input.thumb_url ?? null,
        tagsJson,
        metaJson,
        prefix,
        now,
        existing.id,
      )
      .run();
    return (await getWorkById(env, existing.id))!;
  }

  const result = await env.DB.prepare(
    `INSERT INTO works (
       pixiv_id, kind, title, author, user_id, page_count, x_restrict, sl, restricted,
       source_url, thumb_url, tags_json, meta_json, r2_prefix, file_count, complete, fetched_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
  )
    .bind(
      input.pixiv_id,
      input.kind,
      input.title,
      input.author,
      input.user_id,
      input.page_count,
      input.x_restrict,
      input.sl ?? null,
      input.restricted,
      input.source_url,
      input.thumb_url ?? null,
      tagsJson,
      metaJson,
      prefix,
      now,
    )
    .run();

  const id = result.meta.last_row_id;
  if (!id) {
    const row = await getWorkByPixiv(env, input.pixiv_id, input.kind);
    if (!row) throw new Error("写入作品记录失败");
    return row;
  }
  return (await getWorkById(env, Number(id)))!;
}

export async function listFiles(env: Env, workId: number): Promise<WorkFileRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, work_id, page_index, filename, r2_key, content_type, size
     FROM work_files WHERE work_id = ? ORDER BY page_index ASC`,
  )
    .bind(workId)
    .all<WorkFileRow>();
  return res.results || [];
}

export async function upsertFile(
  env: Env,
  workId: number,
  pageIndex: number,
  filename: string,
  r2Key: string,
  contentType: string,
  size: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO work_files (work_id, page_index, filename, r2_key, content_type, size)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(work_id, page_index) DO UPDATE SET
       filename = excluded.filename,
       r2_key = excluded.r2_key,
       content_type = excluded.content_type,
       size = excluded.size`,
  )
    .bind(workId, pageIndex, filename, r2Key, contentType, size)
    .run();
}

export async function refreshWorkStats(
  env: Env,
  workId: number,
  expectedFiles: number,
  restricted = false,
): Promise<WorkRow> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM work_files WHERE work_id = ?")
    .bind(workId)
    .first<{ n: number }>();
  const n = Number(row?.n || 0);
  const complete = !restricted && expectedFiles > 0 && n >= expectedFiles ? 1 : 0;
  await env.DB.prepare(
    "UPDATE works SET file_count = ?, complete = ?, fetched_at = ? WHERE id = ?",
  )
    .bind(n, complete, Date.now(), workId)
    .run();
  return (await getWorkById(env, workId))!;
}

export async function putBytes(
  env: Env,
  key: string,
  bytes: ArrayBuffer | Uint8Array | string,
  contentType: string,
): Promise<number> {
  const body = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  await env.BUCKET.put(key, body, { httpMetadata: { contentType } });
  return body.byteLength;
}

export async function objectSize(env: Env, key: string): Promise<number | null> {
  const head = await env.BUCKET.head(key);
  return head ? head.size : null;
}

export async function getObject(env: Env, key: string): Promise<R2ObjectBody | null> {
  return env.BUCKET.get(key);
}

export async function listWorks(
  env: Env,
  opts: { q?: string; limit: number; offset: number },
): Promise<{ items: WorkRow[]; total: number }> {
  const limit = Math.max(1, Math.min(opts.limit, 100));
  const offset = Math.max(0, opts.offset);
  const q = (opts.q || "").trim();
  if (q) {
    const like = `%${q}%`;
    const totalRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM works WHERE title LIKE ? OR author LIKE ? OR pixiv_id = ?",
    )
      .bind(like, like, q)
      .first<{ n: number }>();
    const res = await env.DB.prepare(
      `SELECT ${WORK_COLS} FROM works
       WHERE title LIKE ? OR author LIKE ? OR pixiv_id = ?
       ORDER BY fetched_at DESC LIMIT ? OFFSET ?`,
    )
      .bind(like, like, q, limit, offset)
      .all<WorkRow>();
    return { items: res.results || [], total: Number(totalRow?.n || 0) };
  }
  const totalRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM works").first<{ n: number }>();
  const res = await env.DB.prepare(
    `SELECT ${WORK_COLS} FROM works ORDER BY fetched_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all<WorkRow>();
  return { items: res.results || [], total: Number(totalRow?.n || 0) };
}

export async function insertCrawlJob(
  env: Env,
  sourceUrl: string,
  sourceKind: string,
  workCount: number,
  status = "ok",
  note?: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO crawl_jobs (source_url, source_kind, status, work_count, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(sourceUrl, sourceKind, status, workCount, note || null, Date.now())
    .run();
}

export async function deleteWork(env: Env, work: WorkRow): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.BUCKET.list({ prefix: work.r2_prefix, cursor, limit: 100 });
    for (const obj of listed.objects) {
      await env.BUCKET.delete(obj.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  await env.DB.prepare("DELETE FROM translations WHERE work_id = ?").bind(work.id).run();
  await env.DB.prepare("DELETE FROM work_files WHERE work_id = ?").bind(work.id).run();
  await env.DB.prepare("DELETE FROM works WHERE id = ?").bind(work.id).run();
}

export function pixivUrlForWork(work: Pick<WorkRow, "kind" | "pixiv_id" | "source_url">): string {
  if (work.source_url) return work.source_url;
  if (work.kind === "novel") return `https://www.pixiv.net/novel/show.php?id=${work.pixiv_id}`;
  return `https://www.pixiv.net/artworks/${work.pixiv_id}`;
}
