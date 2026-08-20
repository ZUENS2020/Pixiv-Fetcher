import { decryptJson, encryptJson } from "./crypto";
import type { Env, SessPayload } from "./env";

const ROW_ID = 1;

export async function readSess(env: Env): Promise<SessPayload | null> {
  if (!env.COOKIE_ENC_KEY) return null;
  const row = await env.DB.prepare(
    "SELECT token, user_id, user_name, bound_at FROM pixiv_session WHERE id = ?",
  )
    .bind(ROW_ID)
    .first<{ token: string; user_id: string; user_name: string; bound_at: number }>();
  if (!row) return null;
  const payload = await decryptJson<SessPayload>(env.COOKIE_ENC_KEY, row.token);
  if (!payload) return null;
  return {
    ...payload,
    userId: payload.userId || row.user_id,
    userName: payload.userName || row.user_name,
    boundAt: payload.boundAt || row.bound_at,
  };
}

export async function writeSess(env: Env, payload: SessPayload): Promise<void> {
  const token = await encryptJson(env.COOKIE_ENC_KEY, payload);
  await env.DB.prepare(
    `INSERT INTO pixiv_session (id, token, user_id, user_name, bound_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       token = excluded.token,
       user_id = excluded.user_id,
       user_name = excluded.user_name,
       bound_at = excluded.bound_at`,
  )
    .bind(ROW_ID, token, payload.userId, payload.userName, payload.boundAt)
    .run();
}

export async function clearSess(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM pixiv_session WHERE id = ?").bind(ROW_ID).run();
}
