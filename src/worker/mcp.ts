import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { crawlUrl, previewWork } from "./download";
import { extractPixivUrls } from "./parse";
import type { Env } from "./env";
import {
  enqueueTranslateJob,
  findActiveTranslateJob,
  getJob,
  insertJob,
  isStaleJob,
  markJob,
  publicJob,
} from "./jobs";
import { getCachedTranslation, readLlm, toPublic } from "./llm-store";
import { PixivError } from "./pixiv";
import { publicWork } from "./public-work";
import { readSess } from "./session";
import { deleteWork, getWorkById, listFiles, listWorks } from "./store";
import { mcpError, mcpJson } from "./mcp-result";
import { sha256Hex } from "./text";

async function loadNovelText(env: Env, workId: number): Promise<{ work: NonNullable<Awaited<ReturnType<typeof getWorkById>>>; source: string }> {
  const work = await getWorkById(env, workId);
  if (!work) throw new PixivError("文库中没有该作品", 404, "not_found");
  if (work.kind !== "novel") throw new PixivError("目前仅支持小说正文", 400, "upstream");
  const files = await listFiles(env, work.id);
  const txt = files.find((f) => f.filename.endsWith(".txt") || f.content_type.startsWith("text/"));
  if (!txt) throw new PixivError("文库中没有小说正文，请先抓取入库", 404, "not_found");
  const obj = await env.BUCKET.get(txt.r2_key);
  if (!obj) throw new PixivError("小说文件缺失，请重新抓取", 404, "not_found");
  const source = (await obj.text()).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!source) throw new PixivError("正文为空", 404, "not_found");
  return { work, source };
}

export function createPixivMcp(env: Env, request: Request) {
  const server = new McpServer({
    name: "pixiv-fetcher",
    version: "0.1.0",
  });

  server.registerTool(
    "session_status",
    { description: "查看是否已绑定 Pixiv 登录态（不返回 Cookie）", inputSchema: {} },
    async () => {
      const sess = await readSess(env);
      if (!sess) return mcpJson({ bound: false });
      return mcpJson({
        bound: true,
        userId: sess.userId,
        userName: sess.userName,
        boundAt: sess.boundAt,
      });
    },
  );

  server.registerTool(
    "preview_work",
    {
      description: "预览一段文字里的第一条 Pixiv 链接（可把手机分享文案整段贴进来）",
      inputSchema: { url: z.string().describe("Pixiv 链接或含链接的分享文案") },
    },
    async ({ url }) => {
      try {
        const sess = await readSess(env);
        return mcpJson(await previewWork(env, request, sess, url));
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  server.registerTool(
    "crawl_work",
    {
      description: "从一段文字里找出全部 Pixiv 链接并抓取入库",
      inputSchema: { url: z.string().describe("Pixiv 链接或含链接的分享文案") },
    },
    async ({ url }) => {
      try {
        const sess = await readSess(env);
        const urls = extractPixivUrls(url);
        if (!urls.length) throw new PixivError("无法识别的 Pixiv 链接", 400, "upstream");
        if (urls.length === 1) return mcpJson(await crawlUrl(env, request, sess, urls[0]));
        const results = [];
        for (const item of urls) {
          results.push(await crawlUrl(env, request, sess, item));
        }
        return mcpJson({
          title: `${urls.length} 条链接`,
          count: results.reduce((n, r) => n + r.count, 0),
          complete: results.reduce((n, r) => n + r.complete, 0),
          restricted: results.reduce((n, r) => n + r.restricted, 0),
          works: results.flatMap((r) => r.works),
        });
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  server.registerTool(
    "search_library",
    {
      description: "搜索文库作品",
      inputSchema: {
        query: z.string().optional().describe("标题、作者或 pixiv id"),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ query, limit, offset }) => {
      const { items, total } = await listWorks(env, {
        q: query || "",
        limit: limit ?? 20,
        offset: offset ?? 0,
      });
      const out = [];
      for (const work of items) {
        const files = work.complete ? await listFiles(env, work.id) : [];
        out.push(publicWork(work, files));
      }
      return mcpJson({ total, items: out });
    },
  );

  server.registerTool(
    "get_work",
    {
      description: "按文库 id 查看作品元数据和文件列表",
      inputSchema: { id: z.number().int().describe("文库作品 id") },
    },
    async ({ id }) => {
      const work = await getWorkById(env, id);
      if (!work) return mcpError(new PixivError("文库中没有该作品", 404, "not_found"));
      const files = await listFiles(env, work.id);
      return mcpJson(publicWork(work, files));
    },
  );

  server.registerTool(
    "delete_work",
    {
      description: "从文库删除作品及其 R2 文件",
      inputSchema: { id: z.number().int().describe("文库作品 id") },
    },
    async ({ id }) => {
      const work = await getWorkById(env, id);
      if (!work) return mcpError(new PixivError("文库中没有该作品", 404, "not_found"));
      await deleteWork(env, work);
      return mcpJson({ ok: true, id });
    },
  );

  server.registerTool(
    "read_novel",
    {
      description: "读取已入库小说正文，以及缓存的译文（若有）",
      inputSchema: { id: z.number().int().describe("文库作品 id") },
    },
    async ({ id }) => {
      try {
        const { work, source } = await loadNovelText(env, id);
        const llm = toPublic(await readLlm(env));
        const hash = await sha256Hex(source);
        const lang = llm.targetLang || "zh-CN";
        const translation = await getCachedTranslation(env, work.id, hash, lang);
        return mcpJson({
          ...publicWork(work),
          text: source,
          translation,
          llm,
        });
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  server.registerTool(
    "translate_novel",
    {
      description: "把已入库小说交后台翻译。有缓存则直接返回；否则入队并返回 jobId，可用 get_job 查询",
      inputSchema: { workId: z.number().int().describe("文库作品 id") },
    },
    async ({ workId }) => {
      try {
        const cfg = await readLlm(env);
        if (!cfg || !toPublic(cfg).configured) {
          throw new PixivError("请先在设置页配置 LLM API", 400, "upstream");
        }
        const { work, source } = await loadNovelText(env, workId);
        const hash = await sha256Hex(source);
        const lang = cfg.targetLang || "zh-CN";
        const cached = await getCachedTranslation(env, work.id, hash, lang);
        if (cached) return mcpJson({ status: "done", translated: cached, cached: true });
        const existing = await findActiveTranslateJob(env, work.id, hash, lang);
        if (existing && !isStaleJob(existing.updated_at)) {
          return mcpJson({ ...publicJob(existing), cached: false });
        }
        const jobId = existing?.id || crypto.randomUUID();
        if (existing) await markJob(env, jobId, "queued");
        else await insertJob(env, { id: jobId, type: "translate", work_id: work.id, source_hash: hash, target_lang: lang });
        try {
          await enqueueTranslateJob(env, {
            jobId,
            origin: new URL(request.url).origin,
            source,
            cfg,
          });
        } catch (err) {
          await markJob(env, jobId, "error", null, err instanceof Error ? err.message : "入队失败");
          throw err;
        }
        return mcpJson({ status: "queued", jobId, cached: false });
      } catch (err) {
        return mcpError(err);
      }
    },
  );

  server.registerTool(
    "get_job",
    {
      description: "查询后台任务状态（翻译等）",
      inputSchema: { jobId: z.string().describe("任务 id") },
    },
    async ({ jobId }) => {
      const row = await getJob(env, jobId);
      if (!row) return mcpError(new PixivError("任务不存在", 404, "not_found"));
      return mcpJson(publicJob(row));
    },
  );

  return server;
}
