# Pixiv Fetcher 在线预览 + 自定义 LLM 翻译

**方案：** A（Worker 代理翻译，密钥加密存 D1）

**目标：** 文库作品可在站内阅读；用户配置任意 OpenAI 兼容 API，按段落翻译并缓存。UI 遵循 Material 3 窗口尺寸分级。

## 架构

- 阅读数据：`GET /api/library/:id/reader` 从 R2 读小说 txt / 图片列表
- LLM 配置：`GET/PUT /api/llm`，API Key 用现有 `COOKIE_ENC_KEY` AES-GCM 加密
- 翻译：`POST /api/translate` 按段落索引翻译，D1 缓存 `(work_id, para_index, source_hash, lang)`
- 前端：`/read/:id` 阅读器；Compact 上下对照，Expanded 左右分栏

## 翻译策略

OpenAI Chat Completions。System prompt 要求忠实翻译 R-18/R-18G 文学内容（不删减），不是通用越狱。附加提示可由用户编辑。
