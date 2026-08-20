# MCP

Pixiv Fetcher 在同一 Cloudflare Worker 上提供远程 MCP，路径 **`/mcp`**（Streamable HTTP）。协议层**不做登录**；生产环境请用 **Cloudflare Access** 挡在前面。

## 端点

| 环境 | URL |
| --- | --- |
| 生产 | `https://<你的域名或 workers.dev>/mcp` |
| 本地 | wrangler 打印的源 + `/mcp`（常见 `http://127.0.0.1:8787/mcp`） |

不要在浏览器里打开 `/mcp`，要用 MCP 客户端发协议消息。

## 鉴权（Access）

Worker 不校验 MCP token。请任选：

1. **Zero Trust → Access → Applications**：给站点（或只给 `/mcp`）加 self-hosted 应用。
2. **Zero Trust → Access → AI controls → MCP servers**：填 `https://<域名>/mcp`，客户端连上时走 Access 登录。
3. 自动化：Access **Service Token**，请求头  
   `CF-Access-Client-Id` / `CF-Access-Client-Secret`。

不要把 Cookie、LLM Key、D1 id 写进 MCP 配置。

## 客户端

Cursor / Claude 等：

```json
{
  "mcpServers": {
    "pixiv-fetcher": {
      "url": "https://your-domain.example/mcp"
    }
  }
}
```

带 Service Token 时在客户端支持的 `headers` 里加上上述两个 Access 头。

## 工具

| 工具 | 作用 | 参数 |
| --- | --- | --- |
| `session_status` | 是否已绑定 Pixiv 登录态（不含 Cookie） | 无 |
| `preview_work` | 预览链接，写 D1 元数据 | `url` |
| `crawl_work` | 抓取入库到 R2 | `url` |
| `search_library` | 搜文库 | `query?` `limit?` `offset?` |
| `get_work` | 作品元数据与文件列表 | `id`（文库 id） |
| `delete_work` | 删除作品与 R2 对象 | `id` |
| `read_novel` | 已入库小说正文 + 缓存译文 | `id` |
| `translate_novel` | 后台翻译；有缓存则直接返回 | `workId` |
| `get_job` | 查翻译等后台任务 | `jobId` |

翻译依赖设置页已保存的 LLM，以及 `PIXIV_RELAY_URL` / `PIXIV_RELAY_SECRET`。

**不会提供：** 绑定/清除 Cookie、读写 LLM API Key、下载二进制原图（用网页或 `/api/file`）。

## 与网页的关系

MCP 与设置页共用同一份 D1 会话和文库。先在网页录入 Pixiv Cookie（及可选 LLM），再用 MCP 抓取和阅读。
