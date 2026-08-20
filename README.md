# Pixiv Fetcher

单用户 Pixiv 个人离线站：粘贴分享链接，把插画、漫画、小说、动图抓进 **R2**，元数据写入 **D1**，也可下载到当前设备。站内阅读，可选 OpenAI 兼容接口做全文翻译。

只跑 **一个 Cloudflare Worker**（前端挂在同一 Worker）。登录 Cookie 与 LLM 密钥录入后 AES-GCM 加密写入你自己的 D1。Cloudflare 出口打不开 Pixiv 时，加一台 Docker 中继即可。

仅供用自己账号已能访问的内容做个人离线，请遵守 Pixiv 服务条款与当地法律。

完整步骤见 **[docs/DEPLOY.md](docs/DEPLOY.md)**。

## 功能

- 识别 `/artworks/{id}`、小说、小说/漫画系列、用户主页、收藏夹链接
- 预览标题、作者、页数、R18 标记；预览时写入 D1 元数据
- 抓取入库：原图 / 动图 zip / 小说 txt 写入 R2
- 站内阅读；全文翻译在中继后台排队，关页面也会写回 D1
- 设置页粘贴 `PHPSESSID`（或整段 Cookie），校验后存 D1

抓取逻辑对齐 [Powerful Pixiv Downloader](https://github.com/xuejianxianzun/PixivBatchDownloader)。

## 架构

| 组件 | 作用 |
| --- | --- |
| Cloudflare Worker | 网页、API、加密会话、D1/R2 |
| D1 `pixiv-fetcher` | 会话、作品索引、译文、后台任务 |
| R2 `pixiv-fetcher` | `works/{kind}/{id}/` 原文件 |
| Docker 中继（可选） | Pixiv Ajax 转发、LLM 长任务 |

系列 / 用户 / 收藏单次最多抓 **80** 件。已入库作品再次下载会直接读 R2。

## 快速开始

```bash
cp .dev.vars.example .dev.vars
npm install
npx wrangler d1 migrations apply pixiv-fetcher --local
npm run dev
```

生产部署、中继与密钥说明：**[docs/DEPLOY.md](docs/DEPLOY.md)**。

`wrangler.jsonc` 里的 `database_id` 是占位符。部署前执行 `npx wrangler d1 create pixiv-fetcher`，把输出的 id 填进去（不要把真实 id 提交回公开仓库）。

## 登录说明

1. 浏览器登录 [pixiv.net](https://www.pixiv.net)
2. 推荐：F12 → Network → 刷新 → 点一条 `www.pixiv.net` 请求 → 复制 Request Headers 里的整段 Cookie
3. 或只复制 `PHPSESSID`（已登录形态类似 `12345678_xxxxxxxx`）
4. 粘贴到本站设置页并保存

Pixiv 网页会话没有官方固定天数；从 Worker/中继 IP 使用、退出、改密或风控都可能提前失效，重新录入即可。

## 隐私

- 不要把 `.dev.vars`、`relay/.env`、真实 Cookie、LLM Key 或你的 D1 `database_id` 提交到 Git
- 仓库内测试数据是虚构的 `12345678_…`，不是可用会话
