import type { Context } from "hono";
import { Hono } from "hono";
import { extractPhpSessId, buildPixivCookieHeader, isLoggedInSess, userIdFromSess } from "./cookie-parse";
import {
  crawlUrl,
  downloadLibraryWork,
  downloadWork,
  PixivError,
  previewWork,
  proxyAsset,
  serveR2File,
} from "./download";
import type { Env } from "./env";
import { rateLimit } from "./rate-limit";
import { clearSess, readSess, writeSess } from "./session";
import {
  deleteWork,
  getObject,
  getWorkById,
  isSafeR2Key,
  listFiles,
  listWorks,
  type WorkRow,
} from "./store";
import { getCachedTranslation, readLlm, saveTranslation, toPublic, writeLlm } from "./llm-store";
import { testLlm } from "./llm";
import { sha256Hex } from "./text";
import {
  enqueueTranslateJob,
  findActiveTranslateJob,
  getJob,
  insertJob,
  isStaleJob,
  markJob,
  publicJob,
  relayAuthorized,
} from "./jobs";
import { publicWork } from "./public-work";
import { createPixivMcp } from "./mcp";
import { createMcpHandler } from "agents/mcp/server";

const app = new Hono<{ Bindings: Env }>();

function jsonError(c: Context<{ Bindings: Env }>, err: unknown, fallback = 500) {
  if (err instanceof PixivError) {
    return c.json({ error: err.message, code: err.code }, err.status as 400 | 401 | 404 | 409 | 429 | 502 | 503 | 504);
  }
  const message = err instanceof Error ? err.message : "服务器错误";
  return c.json({ error: message }, fallback as 500 | 502);
}

app.get("/api/session", async (c) => {
  const sess = await readSess(c.env);
  if (!sess) return c.json({ bound: false });
  return c.json({
    bound: true,
    userId: sess.userId,
    userName: sess.userName,
    boundAt: sess.boundAt,
  });
});

app.post("/api/session/bind", async (c) => {
  if (!c.env.COOKIE_ENC_KEY) {
    return c.json({ error: "未配置 COOKIE_ENC_KEY" }, 500);
  }
  let body: { cookie?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "无效的 JSON" }, 400);
  }
  const phpSessId = extractPhpSessId(body.cookie || "");
  if (!phpSessId) return c.json({ error: "请粘贴 PHPSESSID 或完整 Cookie" }, 400);
  if (!isLoggedInSess(phpSessId)) {
    return c.json({ error: "这不像已登录的 PHPSESSID（应为 用户ID_一串字符）" }, 400);
  }
  const cookieHeader = buildPixivCookieHeader(body.cookie || "", phpSessId);
  const userAgent = c.req.header("User-Agent") || undefined;
  const userId = userIdFromSess(phpSessId)!;
  await writeSess(c.env, {
    phpSessId,
    cookieHeader,
    userAgent,
    userId,
    userName: `uid:${userId}`,
    boundAt: Date.now(),
  });
  return c.json({
    bound: true,
    userId,
    userName: `uid:${userId}`,
    verified: false,
    message: "已保存到 D1。Pixiv 请求将通过远程浏览器访问，首次预览/下载可能稍慢。",
  });
});

app.delete("/api/session", async (c) => {
  await clearSess(c.env);
  return c.json({ bound: false });
});

app.post("/api/preview", async (c) => {
  const limited = await rateLimit(c.req.raw, "preview", 30, 60);
  if (!limited) return c.json({ error: "预览过于频繁" }, 429);
  let body: { url?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "无效的 JSON" }, 400);
  }
  const sess = await readSess(c.env);
  try {
    const preview = await previewWork(c.env, c.req.raw, sess, body.url || "");
    return c.json(preview);
  } catch (err) {
    return jsonError(c, err, 400);
  }
});

app.post("/api/crawl", async (c) => {
  const limited = await rateLimit(c.req.raw, "crawl", 8, 60);
  if (!limited) return c.json({ error: "抓取过于频繁" }, 429);
  let body: { url?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "无效的 JSON" }, 400);
  }
  const sess = await readSess(c.env);
  try {
    const result = await crawlUrl(c.env, c.req.raw, sess, body.url || "");
    return c.json(result);
  } catch (err) {
    return jsonError(c, err, 400);
  }
});

app.get("/api/proxy", async (c) => {
  const u = c.req.query("u");
  if (!u) return c.json({ error: "missing u" }, 400);
  const sess = await readSess(c.env);
  try {
    return await proxyAsset(u, sess?.userAgent);
  } catch (err) {
    return jsonError(c, err, 400);
  }
});

app.get("/api/file", async (c) => {
  const key = c.req.query("key") || "";
  if (!isSafeR2Key(key)) return c.json({ error: "无效的文件键" }, 400);
  try {
    return await serveR2File(c.env, key, c.req.query("download") === "1");
  } catch (err) {
    return jsonError(c, err, 404);
  }
});

app.get("/api/library", async (c) => {
  const q = c.req.query("q") || "";
  const limit = Number(c.req.query("limit") || 40);
  const offset = Number(c.req.query("offset") || 0);
  const { items, total } = await listWorks(c.env, { q, limit, offset });
  const out = [];
  for (const work of items) {
    const files = work.complete ? await listFiles(c.env, work.id) : [];
    out.push(publicWork(work, files));
  }
  return c.json({ total, items: out });
});

app.get("/api/library/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "无效 id" }, 400);
  const work = await getWorkById(c.env, id);
  if (!work) return c.json({ error: "文库中没有该作品" }, 404);
  const files = await listFiles(c.env, work.id);
  return c.json(publicWork(work, files));
});

app.get("/api/library/:id/download", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "无效 id" }, 400);
  const sess = await readSess(c.env);
  try {
    return await downloadLibraryWork(c.env, c.req.raw, sess, id);
  } catch (err) {
    return jsonError(c, err, 400);
  }
});

app.delete("/api/library/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "无效 id" }, 400);
  const work = await getWorkById(c.env, id);
  if (!work) return c.json({ error: "文库中没有该作品" }, 404);
  await deleteWork(c.env, work);
  return c.json({ ok: true });
});

app.get("/api/llm", async (c) => {
  const cfg = await readLlm(c.env);
  return c.json(toPublic(cfg));
});

app.put("/api/llm", async (c) => {
  if (!c.env.COOKIE_ENC_KEY) return c.json({ error: "未配置 COOKIE_ENC_KEY" }, 500);
  let body: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    targetLang?: string;
    extraPrompt?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "无效的 JSON" }, 400);
  }
  const saved = await writeLlm(c.env, {
    baseUrl: (body.baseUrl || "").trim(),
    model: (body.model || "").trim(),
    apiKey: body.apiKey,
    targetLang: (body.targetLang || "zh-CN").trim() || "zh-CN",
    extraPrompt: body.extraPrompt || "",
  });
  return c.json(saved);
});

app.post("/api/llm/test", async (c) => {
  const cfg = await readLlm(c.env);
  if (!cfg?.apiKey) return c.json({ error: "尚未保存 API Key" }, 400);
  try {
    const reply = await testLlm(cfg);
    return c.json({ ok: true, reply });
  } catch (err) {
    return jsonError(c, err, 400);
  }
});

async function loadNovelText(env: Env, work: WorkRow): Promise<string> {
  const files = await listFiles(env, work.id);
  const txt = files.find((f) => f.filename.endsWith(".txt") || f.content_type.startsWith("text/"));
  if (!txt) throw new PixivError("文库中没有小说正文，请先抓取入库", 404, "not_found");
  const obj = await getObject(env, txt.r2_key);
  if (!obj) throw new PixivError("小说文件缺失，请重新抓取", 404, "not_found");
  return (await obj.text()).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
}

app.get("/api/library/:id/reader", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "无效 id" }, 400);
  const work = await getWorkById(c.env, id);
  if (!work) return c.json({ error: "文库中没有该作品" }, 404);
  const files = await listFiles(c.env, work.id);
  const llm = toPublic(await readLlm(c.env));
  const images = files
    .filter((f) => f.content_type.startsWith("image/"))
    .map((f) => ({
      page: f.page_index,
      filename: f.filename,
      url: `/api/file?key=${encodeURIComponent(f.r2_key)}`,
    }));
  const payload: Record<string, unknown> = {
    ...publicWork(work, files),
    images,
    llm,
  };
  if (work.kind === "novel") {
    try {
      const text = await loadNovelText(c.env, work);
      const hash = await sha256Hex(text);
      const lang = llm.targetLang || "zh-CN";
      payload.text = text;
      payload.translation = await getCachedTranslation(c.env, work.id, hash, lang);
    } catch (err) {
      if (err instanceof PixivError) payload.readerError = err.message;
      else payload.readerError = "无法读取小说正文";
    }
  }
  return c.json(payload);
});

app.post("/api/translate", async (c) => {
  const limited = await rateLimit(c.req.raw, "translate", 8, 60);
  if (!limited) return c.json({ error: "翻译过于频繁" }, 429);
  let body: { workId?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "无效的 JSON" }, 400);
  }
  const workId = Number(body.workId);
  if (!Number.isFinite(workId)) {
    return c.json({ error: "需要 workId" }, 400);
  }
  const work = await getWorkById(c.env, workId);
  if (!work) return c.json({ error: "文库中没有该作品" }, 404);
  if (work.kind !== "novel") return c.json({ error: "目前仅支持翻译小说" }, 400);
  const cfg = await readLlm(c.env);
  if (!cfg || !toPublic(cfg).configured) {
    return c.json({ error: "请先在设置页配置 LLM API" }, 400);
  }
  try {
    const source = await loadNovelText(c.env, work);
    if (!source) return c.json({ error: "正文为空" }, 404);
    const hash = await sha256Hex(source);
    const lang = cfg.targetLang || "zh-CN";
    const cached = await getCachedTranslation(c.env, work.id, hash, lang);
    if (cached) return c.json({ status: "done", translated: cached, cached: true });
    const existing = await findActiveTranslateJob(c.env, work.id, hash, lang);
    if (existing && !isStaleJob(existing.updated_at)) {
      return c.json({ ...publicJob(existing), cached: false });
    }
    const jobId = existing?.id || crypto.randomUUID();
    if (existing) await markJob(c.env, jobId, "queued");
    else await insertJob(c.env, { id: jobId, type: "translate", work_id: work.id, source_hash: hash, target_lang: lang });
    try {
      await enqueueTranslateJob(c.env, {
        jobId,
        origin: new URL(c.req.url).origin,
        source,
        cfg,
      });
    } catch (err) {
      await markJob(c.env, jobId, "error", null, err instanceof Error ? err.message : "入队失败");
      throw err;
    }
    return c.json({ status: "queued", jobId, cached: false });
  } catch (err) {
    return jsonError(c, err, 400);
  }
});

app.get("/api/jobs/:id", async (c) => {
  const row = await getJob(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "任务不存在" }, 404);
  return c.json(publicJob(row));
});

app.post("/api/internal/jobs/complete", async (c) => {
  if (!relayAuthorized(c.req.header("Authorization"), c.env.PIXIV_RELAY_SECRET)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  let body: { jobId?: string; status?: string; translated?: string; error?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "无效的 JSON" }, 400);
  }
  const jobId = String(body.jobId || "");
  const row = await getJob(c.env, jobId);
  if (!row) return c.json({ error: "任务不存在" }, 404);
  if (body.status === "done" && body.translated) {
    if (row.work_id && row.source_hash && row.target_lang) {
      await saveTranslation(c.env, row.work_id, row.source_hash, row.target_lang, body.translated);
    }
    await markJob(c.env, jobId, "done", body.translated, null);
    return c.json({ ok: true });
  }
  await markJob(c.env, jobId, "error", null, body.error || "后台翻译失败");
  return c.json({ ok: true });
});

app.get("/api/download", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "缺少 url" }, 400);
  const sess = await readSess(c.env);
  try {
    return await downloadWork(c.env, c.req.raw, sess, url);
  } catch (err) {
    return jsonError(c, err, 400);
  }
});

app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    return c.json({ error: "not found" }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      return createMcpHandler(() => createPixivMcp(env, request), {
        route: "/mcp",
        allowedHostnames: [url.hostname],
        allowedOriginHostnames: "*",
      })(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
};
