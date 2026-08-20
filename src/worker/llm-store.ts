import { encryptJson, decryptJson } from "./crypto";
import type { Env } from "./env";

const ROW_ID = 1;

export type LlmConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  targetLang: string;
  extraPrompt: string;
};

export type LlmPublic = {
  configured: boolean;
  hasKey: boolean;
  baseUrl: string;
  model: string;
  targetLang: string;
  extraPrompt: string;
};

export async function readLlm(env: Env): Promise<LlmConfig | null> {
  if (!env.COOKIE_ENC_KEY) return null;
  const row = await env.DB.prepare(
    "SELECT base_url, model, api_key_enc, target_lang, extra_prompt FROM llm_settings WHERE id = ?",
  )
    .bind(ROW_ID)
    .first<{
      base_url: string;
      model: string;
      api_key_enc: string | null;
      target_lang: string;
      extra_prompt: string;
    }>();
  if (!row) return null;
  let apiKey = "";
  if (row.api_key_enc) {
    const payload = await decryptJson<{ apiKey: string }>(env.COOKIE_ENC_KEY, row.api_key_enc);
    apiKey = payload?.apiKey || "";
  }
  return {
    baseUrl: row.base_url,
    model: row.model,
    apiKey,
    targetLang: row.target_lang || "zh-CN",
    extraPrompt: row.extra_prompt || "",
  };
}

export function toPublic(cfg: LlmConfig | null): LlmPublic {
  if (!cfg) {
    return {
      configured: false,
      hasKey: false,
      baseUrl: "",
      model: "",
      targetLang: "zh-CN",
      extraPrompt: "",
    };
  }
  return {
    configured: Boolean(cfg.baseUrl && cfg.model && cfg.apiKey),
    hasKey: Boolean(cfg.apiKey),
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    targetLang: cfg.targetLang,
    extraPrompt: cfg.extraPrompt,
  };
}

export async function writeLlm(env: Env, input: Partial<LlmConfig> & { keepKey?: boolean }): Promise<LlmPublic> {
  const current = (await readLlm(env)) || {
    baseUrl: "",
    model: "",
    apiKey: "",
    targetLang: "zh-CN",
    extraPrompt: "",
  };
  const next: LlmConfig = {
    baseUrl: input.baseUrl ?? current.baseUrl,
    model: input.model ?? current.model,
    apiKey: input.apiKey !== undefined && input.apiKey !== "" ? input.apiKey : current.apiKey,
    targetLang: input.targetLang ?? current.targetLang,
    extraPrompt: input.extraPrompt ?? current.extraPrompt,
  };
  const enc = next.apiKey ? await encryptJson(env.COOKIE_ENC_KEY, { apiKey: next.apiKey }) : null;
  await env.DB.prepare(
    `INSERT INTO llm_settings (id, base_url, model, api_key_enc, target_lang, extra_prompt, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       base_url = excluded.base_url,
       model = excluded.model,
       api_key_enc = excluded.api_key_enc,
       target_lang = excluded.target_lang,
       extra_prompt = excluded.extra_prompt,
       updated_at = excluded.updated_at`,
  )
    .bind(ROW_ID, next.baseUrl, next.model, enc, next.targetLang, next.extraPrompt, Date.now())
    .run();
  return toPublic(next);
}

export async function getCachedTranslation(
  env: Env,
  workId: number,
  sourceHash: string,
  lang: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT translated FROM translations
     WHERE work_id = ? AND para_index = 0 AND source_hash = ? AND target_lang = ?`,
  )
    .bind(workId, sourceHash, lang)
    .first<{ translated: string }>();
  return row?.translated ?? null;
}

export async function saveTranslation(
  env: Env,
  workId: number,
  sourceHash: string,
  lang: string,
  translated: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO translations (work_id, para_index, source_hash, target_lang, translated, updated_at)
     VALUES (?, 0, ?, ?, ?, ?)
     ON CONFLICT(work_id, para_index, source_hash, target_lang) DO UPDATE SET
       translated = excluded.translated,
       updated_at = excluded.updated_at`,
  )
    .bind(workId, sourceHash, lang, translated, Date.now())
    .run();
}
