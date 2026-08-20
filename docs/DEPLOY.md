# 部署指南

Pixiv Fetcher 是**单用户自托管**应用：一个 Cloudflare Worker 提供网页与 API，可选一台能访问 `pixiv.net` 的 Docker 主机做 Ajax 中继和后台翻译。

```text
浏览器 ──► Cloudflare Worker（前端 + API + D1 + R2）
                 │
                 ├── 可选：HTTPS 中继（Docker）──► pixiv.net ajax
                 └── 可选：同一中继排队调用你的 LLM，写回 Worker
```

Cookie 与 LLM 密钥用 `COOKIE_ENC_KEY` 加密后只存在你的 D1，不会进 Git。

## 你需要准备

- Node.js 18+
- 已登录的 [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Cloudflare 账号；抓取长漫画/系列建议 **Workers Paid**（免费档外部子请求很少）
- 一台能直连 Pixiv 的机器（本机或 VPS）用于中继；仅预览公开作品、且 Worker 出口未被 Pixiv 拦截时可以先不部署中继

## 1. 创建存储并填 ID

```bash
npm install
npx wrangler d1 create pixiv-fetcher
npx wrangler r2 bucket create pixiv-fetcher
```

把输出的 D1 `database_id` 写进 `wrangler.jsonc` 里对应字段。R2 桶名保持 `pixiv-fetcher` 即可，或同时改配置与 `wrangler r2 bucket create` 的名字。

## 2. 配置密钥

```bash
cp .dev.vars.example .dev.vars   # 仅本地开发
npx wrangler secret put COOKIE_ENC_KEY
```

`COOKIE_ENC_KEY` 用足够长的随机串。换掉它会导致已存的 Cookie / LLM 密钥无法解密，需要在设置页重新录入。

## 3. 部署 Worker

```bash
npx wrangler d1 migrations apply pixiv-fetcher --remote
npm run deploy
```

部署完成后记下 Worker URL，例如 `https://pixiv-fetcher.<你的子域>.workers.dev`，也可在 Cloudflare 里绑自定义域名。

## 4. 部署中继（推荐）

中继做两件事：

1. 从非 Cloudflare 出口访问 Pixiv Ajax（Worker 直连常被 403）
2. 排队跑全文翻译（Worker 在浏览器关掉后最多再续约约 30 秒，不够长文 LLM）

在**中继主机**上：

```bash
cp relay/.env.example relay/.env
# 编辑 relay/.env，把 RELAY_SECRET 换成随机长串
cd relay
docker compose up -d --build
```

容器监听主机 `127.0.0.1:8789`。用 HTTPS 暴露这个端口，任选一种：

**Cloudflare Tunnel（独立主机名）**

```yaml
ingress:
  - hostname: relay.example.com
    service: http://127.0.0.1:8789
  - service: http_status:404
```

**Nginx / Caddy** 可参考 `relay/nginx-snippet.conf`。

远程机器已装 Docker、本机有 SSH 时，也可以：

```bash
# bash
SSH_HOST=your-server RELAY_PUBLIC_URL=https://relay.example.com bash scripts/deploy-relay.sh

# PowerShell
$env:SSH_HOST="your-server"; $env:RELAY_PUBLIC_URL="https://relay.example.com"; .\scripts\deploy-relay.ps1
```

未设置 `SSH_HOST` 时，脚本会在当前仓库的 `relay/` 目录执行 `docker compose up`。

### 把中继交给 Worker

```bash
npx wrangler secret put PIXIV_RELAY_URL     # 例如 https://relay.example.com
npx wrangler secret put PIXIV_RELAY_SECRET  # 与 relay/.env 里 RELAY_SECRET 相同
```

翻译任务会回调 `{Worker 源}/api/internal/jobs/complete`，用同一份 `PIXIV_RELAY_SECRET` 鉴权，无需把 Worker URL 写进中继配置。

检查：`GET https://relay.example.com/health` 应返回 JSON，且带 `ok: true`。

## 5. 第一次使用

1. 打开 Worker 网址 → 设置
2. 粘贴 Pixiv `PHPSESSID` 或整段 Cookie 并保存
3. （可选）填写 OpenAI 兼容 LLM，保存后再开阅读页翻译

## 本地开发

```bash
cp .dev.vars.example .dev.vars
npm install
npx wrangler d1 migrations apply pixiv-fetcher --local
npm run dev
```

本地翻译后台可另开终端：`npm run relay`（默认 `http://127.0.0.1:8788`），并在 `.dev.vars` 里写上 `PIXIV_RELAY_URL` 与 `PIXIV_RELAY_SECRET`。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 预览/抓取 403 | 配置中继；确认 Cookie 未过期；中继主机要能打开 pixiv.net |
| 翻译一直 queued | 看中继容器日志；确认 `PIXIV_RELAY_*` 与 `.env` 一致；Worker 必须是 HTTPS，回调才能成功 |
| D1 报错 unknown database | `wrangler.jsonc` 的 `database_id` 不是当前账号的库 |
| 换过 `COOKIE_ENC_KEY` | 在设置页重新录入 Cookie 和 LLM Key |
