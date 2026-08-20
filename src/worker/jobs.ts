import { PixivError } from "./pixiv";
import type { Env } from "./env";
import type { LlmConfig } from "./llm-store";

export const STALE_JOB_MS = 20 * 60_000;

export type JobRow = {
  id: string;
  type: string;
  status: string;
  work_id: number | null;
  source_hash: string | null;
  target_lang: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export function isStaleJob(updatedAt: number, now = Date.now(), maxMs = STALE_JOB_MS): boolean {
  return now - updatedAt > maxMs;
}

export function publicJob(row: JobRow) {
  return {
    jobId: row.id,
    status: row.status as "queued" | "running" | "done" | "error",
    translated: row.status === "done" ? row.result || undefined : undefined,
    error: row.error || undefined,
  };
}

export function relayAuthorized(header: string | undefined, secret: string | undefined): boolean {
  return Boolean(secret && header === `Bearer ${secret}`);
}

export async function getJob(env: Env, id: string): Promise<JobRow | null> {
  return env.DB.prepare(
    "SELECT id, type, status, work_id, source_hash, target_lang, result, error, created_at, updated_at FROM jobs WHERE id = ?",
  )
    .bind(id)
    .first<JobRow>();
}

export async function findActiveTranslateJob(
  env: Env,
  workId: number,
  sourceHash: string,
  lang: string,
): Promise<JobRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, type, status, work_id, source_hash, target_lang, result, error, created_at, updated_at
     FROM jobs
     WHERE type = 'translate' AND work_id = ? AND source_hash = ? AND target_lang = ?
       AND status IN ('queued', 'running')
     ORDER BY created_at DESC
     LIMIT 1`,
  )
    .bind(workId, sourceHash, lang)
    .first<JobRow>();
  return row ?? null;
}

export async function insertJob(
  env: Env,
  row: Pick<JobRow, "id" | "type" | "work_id" | "source_hash" | "target_lang">,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO jobs (id, type, status, work_id, source_hash, target_lang, result, error, created_at, updated_at)
     VALUES (?, ?, 'queued', ?, ?, ?, NULL, NULL, ?, ?)`,
  )
    .bind(row.id, row.type, row.work_id, row.source_hash, row.target_lang, now, now)
    .run();
}

export async function markJob(env: Env, id: string, status: string, result?: string | null, error?: string | null) {
  await env.DB.prepare(
    "UPDATE jobs SET status = ?, result = COALESCE(?, result), error = ?, updated_at = ? WHERE id = ?",
  )
    .bind(status, result ?? null, error ?? null, Date.now(), id)
    .run();
}

export async function enqueueTranslateJob(
  env: Env,
  opts: {
    jobId: string;
    origin: string;
    source: string;
    cfg: LlmConfig;
  },
): Promise<void> {
  const relayBase = env.PIXIV_RELAY_URL?.replace(/\/$/, "");
  const secret = env.PIXIV_RELAY_SECRET;
  if (!relayBase || !secret) {
    throw new PixivError("未配置翻译后台（PIXIV_RELAY_URL / PIXIV_RELAY_SECRET）", 503, "upstream");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`${relayBase}/jobs`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        id: opts.jobId,
        type: "translate",
        callbackUrl: `${opts.origin}/api/internal/jobs/complete`,
        payload: {
          source: opts.source,
          targetLang: opts.cfg.targetLang || "zh-CN",
          extraPrompt: opts.cfg.extraPrompt || "",
          llm: {
            baseUrl: opts.cfg.baseUrl,
            model: opts.cfg.model,
            apiKey: opts.cfg.apiKey,
          },
        },
      }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new PixivError("翻译后台无响应", 504, "upstream");
    }
    throw new PixivError("无法连接翻译后台", 502, "upstream");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok && res.status !== 202) {
    const text = await res.text();
    let msg = `翻译后台返回 ${res.status}`;
    try {
      const data = JSON.parse(text) as { error?: string };
      if (data.error) msg = data.error;
    } catch {
      /* ignore */
    }
    throw new PixivError(msg, res.status >= 400 && res.status < 500 ? 400 : 502, "upstream");
  }
}
