import { extractPixivUrls } from "../worker/parse";

type Session = {
  bound: boolean;
  userId?: string;
  userName?: string;
  boundAt?: number;
};

type Preview = {
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

type HistoryItem = {
  url: string;
  title: string;
  kind: string;
  at: number;
};

const HISTORY_KEY = "pixiv-fetcher-history";

const kindLabel: Record<string, string> = {
  illust: "插画",
  manga: "漫画",
  ugoira: "动图",
  novel: "小说",
  novel_series: "小说系列",
  manga_series: "漫画系列",
  user: "用户作品",
  bookmarks: "收藏",
};

function restrictLabel(n: number): string {
  if (n === 2) return "R-18G";
  if (n === 1) return "R-18";
  return "全年龄";
}

type LibraryItem = {
  id: number;
  pixivId: string;
  kind: string;
  title: string;
  author: string;
  pageCount: number;
  xRestrict: number;
  restricted: boolean;
  complete: boolean;
  fileCount: number;
  sourceUrl: string;
  thumb: string | null;
  fetchedAt: number;
};

type LlmPublic = {
  configured: boolean;
  hasKey: boolean;
  baseUrl: string;
  model: string;
  targetLang: string;
  extraPrompt: string;
};

type ReaderPayload = LibraryItem & {
  images: Array<{ page: number; filename: string; url: string }>;
  llm: LlmPublic;
  text?: string;
  translation?: string | null;
  readerError?: string;
};

function $(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

function loadHistory(): HistoryItem[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]") as HistoryItem[];
  } catch {
    return [];
  }
}

function saveHistory(items: HistoryItem[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 50)));
}

function pushHistory(item: HistoryItem) {
  const next = [item, ...loadHistory().filter((x) => x.url !== item.url)];
  saveHistory(next);
}

function route(): string {
  return location.pathname.replace(/\/+$/, "") || "/";
}

const icon = {
  download: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M5 20h14v-2H5v2zm14-11h-4V3H9v6H5l7 7 7-7z"/></svg>`,
  library: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2z"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54A.49.49 0 0 0 13.9 2h-3.8a.49.49 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.55-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.48a.5.5 0 0 0 .12.64L4.86 10.7c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.16a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.4.32.64.22l2.39-.96c.5.39 1.04.7 1.63.94l.36 2.54c.05.24.25.42.49.42h3.8c.24 0 .44-.18.49-.42l.36-2.54c.59-.24 1.13-.55 1.63-.94l2.39.96c.24.1.51 0 .64-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>`,
  history: `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M13 3a9 9 0 1 0 8.94 10h-2.02A7 7 0 1 1 13 5V8l4-4-4-4v3zm1 8V8h-2v5l4.25 2.52.75-1.23L14 11z"/></svg>`,
};

function navItems(active: string) {
  const items = [
    { href: "/", label: "下载", icon: icon.download },
    { href: "/library", label: "文库", icon: icon.library },
    { href: "/history", label: "历史", icon: icon.history },
    { href: "/settings", label: "设置", icon: icon.settings },
  ];
  return items
    .map(
      (it) =>
        `<a class="md-nav-item ${active === it.href || (it.href !== "/" && active.startsWith(it.href)) ? "active" : ""}" href="${it.href}">${it.icon}<span>${it.label}</span></a>`,
    )
    .join("");
}

function syncChrome(active: string) {
  const rail = document.getElementById("rail")!;
  const bar = document.getElementById("bar")!;
  rail.hidden = false;
  bar.hidden = false;
  rail.innerHTML = navItems(active.startsWith("/read") ? "/library" : active === "/" ? "/" : active);
  bar.innerHTML = navItems(active.startsWith("/read") ? "/library" : active === "/" ? "/" : active);
  for (const el of bar.querySelectorAll<HTMLElement>(".md-nav-item")) {
    el.style.flex = "1 1 0%";
    el.style.width = "0px";
    el.style.minWidth = "0";
    el.style.maxWidth = "none";
  }
  document.getElementById("app")!.classList.toggle("reader-mode", active.startsWith("/read"));
}

function brandHeader(title = ""): HTMLElement {
  return $(`<div class="topbar">
    <div class="brand">Pixiv <span>Fetcher</span></div>
    ${title ? `<p class="help" style="margin:0">${escapeHtml(title)}</p>` : ""}
  </div>`);
}

function extractUrls(raw: string): string[] {
  return extractPixivUrls(raw);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TRANSLATE_CONCURRENCY = 5;

async function mapLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

type TranslateJob = {
  status: "queued" | "running" | "done" | "error";
  jobId?: string;
  translated?: string;
  cached?: boolean;
  error?: string;
};

async function runTranslate(
  workId: number,
  onProgress?: (msg: string) => void,
): Promise<{ translated: string; cached: boolean }> {
  const start = await api<TranslateJob>("/api/translate", {
    method: "POST",
    body: JSON.stringify({ workId }),
  });
  if (start.status === "done" && start.translated) {
    return { translated: start.translated, cached: Boolean(start.cached) };
  }
  if (start.status === "error") throw new Error(start.error || "翻译失败");
  if (!start.jobId) throw new Error("未能创建后台翻译任务");
  onProgress?.("已交给 Docker 后台，正在翻译…");
  for (let i = 0; i < 240; i += 1) {
    await sleep(2000);
    const job = await api<TranslateJob>(`/api/jobs/${start.jobId}`);
    if (job.status === "done" && job.translated) {
      return { translated: job.translated, cached: false };
    }
    if (job.status === "error") throw new Error(job.error || "翻译失败");
    onProgress?.(`后台翻译中（${(i + 1) * 2}s）…`);
  }
  throw new Error("仍在后台翻译，请稍后刷新阅读页");
}

function startDownload(href: string) {
  const a = document.createElement("a");
  a.href = href;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
}

async function renderHome(root: HTMLElement, session: Session) {
  root.innerHTML = "";
  root.append(
    brandHeader(),
    $(`<p class="lede">把手机分享文案整段贴进来即可，会自动找出其中的 pixiv 链接。「抓取入库」和「下载」按顺序处理全部识别到的链接；系列与用户页每次最多约 80 件。</p>`),
  );

  const form = $(`<div>
      <label for="url">分享文案或链接（可混杂文字）</label>
      <textarea id="url" placeholder="把 App 分享出来的标题、标签和链接整段粘贴到这里"></textarea>
    <div class="row actions-main">
      <button type="button" id="previewBtn">预览</button>
      <button type="button" class="ghost" id="crawlBtn">抓取入库</button>
      <button type="button" class="ghost" id="downloadBtn">下载</button>
    </div>
    <div class="status" id="status">${session.bound ? `已录入 D1：${session.userName}` : "尚未录入 Pixiv Cookie，只能预览公开作品。"}</div>
    <div id="result"></div>
  </div>`);
  root.append(form);

  const urlEl = form.querySelector("#url") as HTMLTextAreaElement;
  const status = form.querySelector("#status") as HTMLElement;
  const result = form.querySelector("#result") as HTMLElement;
  const previewBtn = form.querySelector("#previewBtn") as HTMLButtonElement;
  const crawlBtn = form.querySelector("#crawlBtn") as HTMLButtonElement;
  const downloadBtn = form.querySelector("#downloadBtn") as HTMLButtonElement;
  let currentUrl = "";
  let currentPreview: Preview | null = null;
  let libraryId: number | null = null;

  function showPreview(p: Preview) {
    currentPreview = p;
    const thumb = p.thumb ? `/api/proxy?u=${encodeURIComponent(p.thumb)}` : "";
    result.innerHTML = "";
    result.append(
      $(`<article class="card preview">
        ${thumb ? `<img src="${thumb}" alt="">` : `<div></div>`}
        <div class="meta">
          <div class="title">${escapeHtml(p.title)}</div>
          <div>${escapeHtml(p.author)} · ${kindLabel[p.kind] || p.kind}</div>
          <div style="margin-top:8px">
            <span class="badge ${p.xRestrict ? "r18" : ""}">${restrictLabel(p.xRestrict)}</span>
            <span class="badge">${p.pageCount} 页 / 话</span>
            ${p.cached ? `<span class="badge">已在文库</span>` : ""}
          </div>
          <div class="row" id="previewActions"></div>
        </div>
      </article>`),
    );
    crawlBtn.disabled = false;
    downloadBtn.disabled = false;
    if (p.needLogin) {
      status.className = "status err";
      status.textContent = "该作品需要登录。请先到设置录入 Pixiv Cookie。";
    }
  }

  previewBtn.addEventListener("click", async () => {
    const urls = extractUrls(urlEl.value);
    currentUrl = urls[0] || "";
    libraryId = null;
    status.className = "status";
    if (!currentUrl) {
      status.className = "status err";
      status.textContent = "没有识别到 pixiv 链接，把分享文案整段贴进来即可";
      return;
    }
    status.textContent = urls.length > 1 ? `识别到 ${urls.length} 条，先预览第 1 条…` : "正在读取…";
    crawlBtn.disabled = true;
    downloadBtn.disabled = true;
    result.innerHTML = "";
    try {
      const p = await api<Preview>("/api/preview", {
        method: "POST",
        body: JSON.stringify({ url: currentUrl }),
      });
      status.className = "status ok";
      status.textContent = "已获取作品信息";
      showPreview(p);
    } catch (err) {
      status.className = "status err";
      status.textContent = err instanceof Error ? err.message : "预览失败";
    }
  });

  crawlBtn.addEventListener("click", async () => {
    const urls = extractUrls(urlEl.value);
    if (!urls.length) {
      status.className = "status err";
      status.textContent = "没有识别到 pixiv 链接，把分享文案整段贴进来即可";
      return;
    }
    crawlBtn.disabled = true;
    let ok = 0;
    let fail = 0;
    const errors: string[] = [];
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      currentUrl = url;
      status.className = "status";
      status.textContent = urls.length > 1 ? `抓取入库 ${i + 1}/${urls.length}…` : "正在抓取并写入 R2…";
      try {
        const crawled = await api<{
          count: number;
          complete: number;
          restricted: number;
          title: string;
          works?: Array<{ id: number }>;
        }>("/api/crawl", { method: "POST", body: JSON.stringify({ url }) });
        ok += crawled.complete;
        libraryId = crawled.works?.[0]?.id ?? libraryId;
        pushHistory({
          url,
          title: crawled.title || currentPreview?.title || url,
          kind: currentPreview?.kind || "illust",
          at: Date.now(),
        });
        if (urls.length === 1) {
          status.className = "status ok";
          status.textContent = `已入库 ${crawled.complete}/${crawled.count} 件「${crawled.title}」${
            crawled.restricted ? `，${crawled.restricted} 件受限制` : ""
          }`;
          const actions = result.querySelector("#previewActions");
          if (actions && libraryId) {
            actions.innerHTML = "";
            actions.append($(`<a class="btn" href="/read/${libraryId}">在线阅读</a>`));
          }
        }
      } catch (err) {
        fail += 1;
        errors.push(`${url}：${err instanceof Error ? err.message : "失败"}`);
      }
    }
    if (urls.length > 1) {
      status.className = fail ? "status err" : "status ok";
      status.textContent = `抓取结束：入库约 ${ok} 件，失败 ${fail} 条。${errors.slice(0, 3).join("；")}`;
    } else if (fail) {
      status.className = "status err";
      status.textContent = errors[0] || "抓取失败";
    }
    crawlBtn.disabled = false;
  });

  downloadBtn.addEventListener("click", async () => {
    const urls = extractUrls(urlEl.value);
    if (!urls.length) {
      status.className = "status err";
      status.textContent = "没有识别到 pixiv 链接，把分享文案整段贴进来即可";
      return;
    }
    downloadBtn.disabled = true;
    if (urls.length === 1) {
      currentUrl = urls[0];
      if (currentPreview) {
        pushHistory({
          url: currentUrl,
          title: currentPreview.title,
          kind: currentPreview.kind,
          at: Date.now(),
        });
      }
      location.href = `/api/download?url=${encodeURIComponent(currentUrl)}`;
      status.className = "status ok";
      status.textContent = "已开始下载（同时写入文库）";
    } else {
      for (let i = 0; i < urls.length; i += 1) {
        status.className = "status";
        status.textContent = `下载 ${i + 1}/${urls.length}…`;
        startDownload(`/api/download?url=${encodeURIComponent(urls[i])}`);
        await sleep(900);
      }
      status.className = "status ok";
      status.textContent = `已触发 ${urls.length} 个下载（同时写入文库）。若浏览器拦截，请允许本站多次下载。`;
    }
    downloadBtn.disabled = false;
  });
}

async function renderSettings(root: HTMLElement, session: Session) {
  root.innerHTML = "";
  root.append(brandHeader("设置"));

  const box = $(`<div>
    <div class="card">
      <h2>当前绑定</h2>
      <p class="help" id="bindState"></p>
      <div class="row">
        <button class="ghost" type="button" id="unbindBtn">清除</button>
      </div>
    </div>
    <div class="card">
      <h2>录入 PHPSESSID</h2>
      <p class="help">
        本站只有一个用户：录入一次后加密写入 D1，所有访问共用这份 Pixiv 登录态。<br>
        <strong>必须先登录 pixiv.net</strong>，Cookies 列表里应能看到 <code>PHPSESSID</code>（形如 <code>12345678_xxxx</code>）。你截图里若没有这项，说明还没登录成功。<br><br>
        <strong>推荐：从 Network 复制整段 Cookie</strong>（可含 HttpOnly，比 Application 里逐个复制省事）<br>
        1. 保持已登录的 pixiv.net 标签页<br>
        2. F12 → <strong>Network / 网络</strong> → 刷新页面<br>
        3. 点任意一条 <code>www.pixiv.net</code> 请求 → <strong>Headers / 标头</strong><br>
        4. 找到 <strong>Request Headers → Cookie:</strong>，右键复制整行值，粘贴到下面<br><br>
        备选：Application → Cookies → www.pixiv.net，只复制 <code>PHPSESSID</code> 的值也行
      </p>
      <label for="cookie">PHPSESSID 或整段 Cookie</label>
      <textarea id="cookie" placeholder="PHPSESSID=12345678_xxxx; privacy_policy_agreement=7; ..."></textarea>
      <div class="row"><button type="button" id="bindBtn">保存到 D1</button></div>
      <div class="status" id="bindStatus"></div>
    </div>
    <div class="card">
      <h2>翻译 LLM</h2>
      <p class="help">OpenAI 兼容接口（DeepSeek / OpenRouter / Ollama / LM Studio 等）。密钥加密写入 D1；全文翻译在 Docker 中继后台跑，不占用 Worker 时限。</p>
      <label for="llmBase">Base URL</label>
      <input type="url" id="llmBase" placeholder="https://api.deepseek.com/v1" />
      <label for="llmModel">模型名</label>
      <input type="text" id="llmModel" placeholder="deepseek-chat" />
      <label for="llmKey">API Key（留空则保留已保存的密钥）</label>
      <input type="password" id="llmKey" autocomplete="off" />
      <label for="llmLang">目标语言</label>
      <input type="text" id="llmLang" placeholder="zh-CN" />
      <label for="llmExtra">附加翻译要求（可选）</label>
      <textarea id="llmExtra" placeholder="例如：人名按约定译法；保留日文拟声词"></textarea>
      <div class="row">
        <button type="button" id="llmSave">保存 LLM</button>
        <button type="button" class="ghost" id="llmTest">测试连接</button>
      </div>
      <div class="status" id="llmStatus"></div>
    </div>
  </div>`);
  root.append(box);

  const bindState = box.querySelector("#bindState") as HTMLElement;
  const bindStatus = box.querySelector("#bindStatus") as HTMLElement;
  const llmStatus = box.querySelector("#llmStatus") as HTMLElement;

  function setBound(s: Session) {
    bindState.textContent = s.bound
      ? `已绑定 ${s.userName}（uid ${s.userId}），全站共用`
      : "尚未录入。未登录只能下载公开作品。";
  }
  setBound(session);

  try {
    const llm = await api<LlmPublic>("/api/llm");
    (box.querySelector("#llmBase") as HTMLInputElement).value = llm.baseUrl;
    (box.querySelector("#llmModel") as HTMLInputElement).value = llm.model;
    (box.querySelector("#llmLang") as HTMLInputElement).value = llm.targetLang || "zh-CN";
    (box.querySelector("#llmExtra") as HTMLTextAreaElement).value = llm.extraPrompt;
    llmStatus.className = "status";
    llmStatus.textContent = llm.configured
      ? `已配置 ${llm.model}${llm.hasKey ? "（密钥已保存）" : ""}`
      : "尚未配置";
  } catch (err) {
    llmStatus.className = "status err";
    llmStatus.textContent = err instanceof Error ? err.message : "读取 LLM 配置失败";
  }

  box.querySelector("#bindBtn")!.addEventListener("click", async () => {
    const cookie = (box.querySelector("#cookie") as HTMLTextAreaElement).value;
    bindStatus.className = "status";
    bindStatus.textContent = "正在保存…";
    try {
      const s = await api<Session & { message?: string }>("/api/session/bind", {
        method: "POST",
        body: JSON.stringify({ cookie }),
      });
      bindStatus.className = "status ok";
      bindStatus.textContent = s.message || `已写入 D1：${s.userName}`;
      setBound(s);
    } catch (err) {
      bindStatus.className = "status err";
      bindStatus.textContent = err instanceof Error ? err.message : "绑定失败";
    }
  });

  box.querySelector("#unbindBtn")!.addEventListener("click", async () => {
    await api("/api/session", { method: "DELETE" });
    setBound({ bound: false });
    bindStatus.className = "status";
    bindStatus.textContent = "已从 D1 清除";
  });

  box.querySelector("#llmSave")!.addEventListener("click", async () => {
    llmStatus.className = "status";
    llmStatus.textContent = "正在保存…";
    try {
      const saved = await api<LlmPublic>("/api/llm", {
        method: "PUT",
        body: JSON.stringify({
          baseUrl: (box.querySelector("#llmBase") as HTMLInputElement).value,
          model: (box.querySelector("#llmModel") as HTMLInputElement).value,
          apiKey: (box.querySelector("#llmKey") as HTMLInputElement).value,
          targetLang: (box.querySelector("#llmLang") as HTMLInputElement).value,
          extraPrompt: (box.querySelector("#llmExtra") as HTMLTextAreaElement).value,
        }),
      });
      (box.querySelector("#llmKey") as HTMLInputElement).value = "";
      llmStatus.className = "status ok";
      llmStatus.textContent = saved.configured ? `已保存 ${saved.model}` : "已保存（尚未填齐 URL / 模型 / Key）";
    } catch (err) {
      llmStatus.className = "status err";
      llmStatus.textContent = err instanceof Error ? err.message : "保存失败";
    }
  });

  box.querySelector("#llmTest")!.addEventListener("click", async () => {
    llmStatus.className = "status";
    llmStatus.textContent = "正在测试…";
    try {
      const r = await api<{ ok: boolean; reply: string }>("/api/llm/test", { method: "POST" });
      llmStatus.className = "status ok";
      llmStatus.textContent = `连通：${r.reply.slice(0, 80)}`;
    } catch (err) {
      llmStatus.className = "status err";
      llmStatus.textContent = err instanceof Error ? err.message : "测试失败";
    }
  });
}

async function renderLibrary(root: HTMLElement) {
  root.innerHTML = "";
  root.append(brandHeader("文库"), $(`<p class="lede">已抓取的作品在 D1 + R2。勾选后可批量下载或翻译小说。</p>`));
  const box = $(`<div class="card">
    <h2>云端文库</h2>
    <input type="text" id="q" placeholder="搜索标题 / 作者 / ID" />
    <div class="row">
      <button type="button" class="ghost" id="selAll">全选</button>
      <button type="button" class="ghost" id="selNone">取消全选</button>
    </div>
    <div class="row batch-bar">
      <button type="button" id="batchDl">批量下载</button>
      <button type="button" class="tonal" id="batchTr">批量翻译小说</button>
    </div>
    <div class="status" id="batchStatus"></div>
    <div id="list"></div>
    <p class="help" id="pager"></p>
  </div>`);
  root.append(box);
  const list = box.querySelector("#list") as HTMLElement;
  const pager = box.querySelector("#pager") as HTMLElement;
  const qEl = box.querySelector("#q") as HTMLInputElement;
  const batchStatus = box.querySelector("#batchStatus") as HTMLElement;
  let itemsCache: LibraryItem[] = [];

  function selectedItems(): LibraryItem[] {
    const ids = new Set(
      [...list.querySelectorAll<HTMLInputElement>("input[data-id]:checked")].map((el) => Number(el.dataset.id)),
    );
    return itemsCache.filter((it) => ids.has(it.id));
  }

  async function load() {
    list.innerHTML = `<p class="help">读取中…</p>`;
    try {
      const data = await api<{ total: number; items: LibraryItem[] }>(
        `/api/library?limit=80&q=${encodeURIComponent(qEl.value.trim())}`,
      );
      itemsCache = data.items;
      list.innerHTML = "";
      if (!data.items.length) {
        list.innerHTML = `<p class="help">文库是空的。到下载页预览后点「抓取入库」。</p>`;
      }
      for (const item of data.items) {
        const restrict = item.xRestrict === 2 ? "R-18G" : item.xRestrict === 1 ? "R-18" : "";
        const state = item.restricted ? "受限" : item.complete ? "已缓存" : "仅元数据";
        const row = $(`<div class="history-item lib-row${item.thumb ? "" : " no-thumb"}">
          <label class="check"><input type="checkbox" data-id="${item.id}" data-kind="${item.kind}" aria-label="选择 ${escapeHtml(item.title)}"></label>
          ${item.thumb ? `<img class="lib-thumb" src="${item.thumb}" alt="">` : ""}
          <div class="lib-body">
            <div class="lib-title">${escapeHtml(item.title)}</div>
            <div class="help">${escapeHtml(item.author)} · ${kindLabel[item.kind] || item.kind} · ${item.fileCount} 文件 · ${state}${restrict ? ` · ${restrict}` : ""}</div>
          </div>
          <div class="lib-actions">
            <a class="btn" href="/read/${item.id}">阅读</a>
            <button type="button" class="ghost" data-act="dl">下载</button>
            <button type="button" class="ghost" data-act="del">删除</button>
          </div>
        </div>`);
        row.querySelector('[data-act="dl"]')!.addEventListener("click", () => {
          location.href = `/api/library/${item.id}/download`;
        });
        row.querySelector('[data-act="del"]')!.addEventListener("click", async () => {
          if (!confirm(`删除「${item.title}」以及 R2 上的文件？`)) return;
          try {
            await api(`/api/library/${item.id}`, { method: "DELETE" });
            await load();
          } catch (err) {
            pager.textContent = err instanceof Error ? err.message : "删除失败";
          }
        });
        list.append(row);
      }
      pager.textContent = `共 ${data.total} 件`;
    } catch (err) {
      list.innerHTML = "";
      pager.textContent = err instanceof Error ? err.message : "读取失败";
    }
  }

  let timer = 0;
  qEl.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void load(), 280);
  });

  box.querySelector("#selAll")!.addEventListener("click", () => {
    for (const el of list.querySelectorAll<HTMLInputElement>("input[data-id]")) el.checked = true;
  });
  box.querySelector("#selNone")!.addEventListener("click", () => {
    for (const el of list.querySelectorAll<HTMLInputElement>("input[data-id]")) el.checked = false;
  });
  box.querySelector("#batchDl")!.addEventListener("click", async () => {
    const picked = selectedItems();
    if (!picked.length) {
      batchStatus.className = "status err";
      batchStatus.textContent = "请先勾选作品";
      return;
    }
    for (let i = 0; i < picked.length; i += 1) {
      batchStatus.className = "status";
      batchStatus.textContent = `批量下载 ${i + 1}/${picked.length}：「${picked[i].title}」`;
      startDownload(`/api/library/${picked[i].id}/download`);
      await sleep(900);
    }
    batchStatus.className = "status ok";
    batchStatus.textContent = `已触发 ${picked.length} 个下载。若浏览器拦截，请允许多次下载。`;
  });
  box.querySelector("#batchTr")!.addEventListener("click", async () => {
    const novels = selectedItems().filter((it) => it.kind === "novel");
    if (!novels.length) {
      batchStatus.className = "status err";
      batchStatus.textContent = "请勾选至少一篇已入库的小说";
      return;
    }
    const btn = box.querySelector("#batchTr") as HTMLButtonElement;
    btn.disabled = true;
    let ok = 0;
    let fail = 0;
    let running = 0;
    const refresh = () => {
      batchStatus.className = fail ? "status err" : "status";
      batchStatus.textContent = `批量翻译：完成 ${ok}/${novels.length}，失败 ${fail}，进行中 ${running}（最多 ${TRANSLATE_CONCURRENCY} 路）`;
    };
    refresh();
    await mapLimit(novels, TRANSLATE_CONCURRENCY, async (novel) => {
      running += 1;
      refresh();
      try {
        await runTranslate(novel.id);
        ok += 1;
      } catch {
        fail += 1;
      } finally {
        running -= 1;
        refresh();
      }
    });
    if (fail === 0) {
      batchStatus.className = "status ok";
      batchStatus.textContent = `已翻译 ${ok} 篇小说，打开阅读页即可看译文`;
    } else {
      batchStatus.className = "status err";
      batchStatus.textContent = `翻译结束：成功 ${ok}，失败 ${fail}`;
    }
    btn.disabled = false;
  });

  await load();
}

async function renderReader(root: HTMLElement, id: number) {
  root.innerHTML = "";
  root.append(brandHeader("阅读"));
  const status = $(`<p class="status">正在打开…</p>`);
  root.append(status);
  let data: ReaderPayload;
  try {
    data = await api<ReaderPayload>(`/api/library/${id}/reader`);
  } catch (err) {
    status.className = "status err";
    status.textContent = err instanceof Error ? err.message : "打开失败";
    return;
  }
  status.remove();

  const head = $(`<div class="card">
    <div class="meta">
      <div class="title">${escapeHtml(data.title)}</div>
      <div>${escapeHtml(data.author)} · ${kindLabel[data.kind] || data.kind}</div>
      <div style="margin-top:8px">
        <span class="badge ${data.xRestrict ? "r18" : ""}">${restrictLabel(data.xRestrict)}</span>
        <span class="badge">${data.pageCount} 页 / 话</span>
      </div>
    </div>
  </div>`);
  root.append(head);

  if (data.kind === "novel") {
    await renderNovelReader(root, data);
    return;
  }
  if (data.images?.length) {
    const gallery = $(`<div class="gallery card"></div>`);
    for (const img of data.images) {
      const el = $(`<img src="${img.url}" alt="${escapeHtml(img.filename)}" loading="lazy">`) as HTMLImageElement;
      el.addEventListener("click", () => {
        const overlay = $(`<div class="lightbox" role="dialog" aria-label="原图"><img src="${img.url}" alt=""></div>`);
        overlay.addEventListener("click", () => overlay.remove());
        document.body.append(overlay);
      });
      gallery.append(el);
    }
    root.append(gallery);
    return;
  }
  root.append(
    $(`<p class="help">没有可在线预览的图片。${data.kind === "ugoira" ? "动图请下载 zip。" : "请先抓取入库。"}</p>
      <div class="row"><a class="btn" href="/api/library/${data.id}/download">下载</a></div>`),
  );
}

async function renderNovelReader(root: HTMLElement, data: ReaderPayload) {
  if (data.readerError) {
    root.append($(`<p class="status err">${escapeHtml(data.readerError)}</p>`));
    return;
  }
  const source = data.text || "";
  let translated = data.translation || "";
  const bar = $(`<div class="reader-toolbar">
    <button type="button" class="tonal" id="trAll" ${data.llm.configured ? "" : "disabled"}>翻译全文</button>
    <a class="btn ghost" href="/settings">LLM 设置</a>
    <p class="help reader-hint" id="trHint">${data.llm.configured ? `目标：${escapeHtml(data.llm.targetLang)} · ${escapeHtml(data.llm.model)} · 后台 Docker` : "未配置 LLM，只能看原文"}</p>
  </div>`);
  const pair = $(`<article class="doc-pair card">
    <div>
      <h2>原文</h2>
      <div class="src doc">${escapeHtml(source)}</div>
    </div>
    <div>
      <h2>译文</h2>
      <div class="dst doc ${translated ? "" : "empty"}" id="dst">${translated ? escapeHtml(translated) : "尚未翻译"}</div>
    </div>
  </article>`);
  root.append(bar, pair);
  const hint = bar.querySelector("#trHint") as HTMLElement;
  const dst = pair.querySelector("#dst") as HTMLElement;
  const btn = bar.querySelector("#trAll") as HTMLButtonElement;

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    dst.className = "dst doc empty";
    dst.textContent = "已交给后台容器翻译，篇幅较长时可离开本页稍后回来…";
    hint.textContent = "排队中…";
    try {
      const r = await runTranslate(data.id, (msg) => {
        hint.textContent = msg;
        dst.textContent = msg;
      });
      translated = r.translated;
      dst.className = "dst doc";
      dst.textContent = r.translated;
      hint.textContent = r.cached ? "已使用缓存译文" : "全文翻译完成";
    } catch (err) {
      dst.className = "dst doc empty";
      dst.textContent = err instanceof Error ? err.message : "翻译失败";
      hint.textContent = err instanceof Error ? err.message : "翻译失败";
    } finally {
      btn.disabled = !data.llm.configured;
    }
  });
}

function renderHistory(root: HTMLElement) {
  root.innerHTML = "";
  root.append(brandHeader("历史"));
  const items = loadHistory();
  const box = $(`<div class="card">
    <h2>本机历史</h2>
    <p class="help">只存在这台浏览器的 localStorage。</p>
    <div id="list"></div>
    <div class="row"><button class="ghost" type="button" id="clear">清空</button></div>
  </div>`);
  root.append(box);
  const list = box.querySelector("#list") as HTMLElement;
  if (!items.length) list.innerHTML = `<p class="help">暂无记录</p>`;
  for (const item of items) {
    const row = $(`<div class="history-item">
      <div>
        <div>${escapeHtml(item.title)}</div>
        <div class="help">${kindLabel[item.kind] || item.kind} · ${new Date(item.at).toLocaleString()}</div>
      </div>
      <button type="button">再下</button>
    </div>`);
    row.querySelector("button")!.addEventListener("click", () => {
      location.href = `/api/download?url=${encodeURIComponent(item.url)}`;
    });
    list.append(row);
  }
  box.querySelector("#clear")!.addEventListener("click", () => {
    saveHistory([]);
    void render();
  });
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function render() {
  const root = document.getElementById("app")!;
  let session: Session = { bound: false };
  try {
    session = await api<Session>("/api/session");
  } catch {
    session = { bound: false };
  }
  const path = route();
  const read = path.match(/^\/read\/(\d+)$/);
  syncChrome(read ? "/read" : path);
  if (path === "/settings") await renderSettings(root, session);
  else if (path === "/history") renderHistory(root);
  else if (path === "/library") await renderLibrary(root);
  else if (read) await renderReader(root, Number(read[1]));
  else await renderHome(root, session);
}

document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href || href.startsWith("http") || href.startsWith("/api/") || a.target === "_blank") return;
  e.preventDefault();
  history.pushState({}, "", href);
  void render();
});

window.addEventListener("popstate", () => void render());
void render();
