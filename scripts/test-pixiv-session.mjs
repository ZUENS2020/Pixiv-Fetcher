/**
 * 本地测试 Pixiv 登录态校验逻辑（不经过 Worker）。
 * 用法: node scripts/test-pixiv-session.mjs [PHPSESSID 或整段 Cookie]
 */
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PIXIV_REFERER = "https://www.pixiv.net/";

function extractPhpSessId(input) {
  const trimmed = input.trim().replace(/^Cookie:\s*/i, "");
  const fromPair = trimmed.match(/PHPSESSID=([^;\s]+)/i);
  if (fromPair) return decodeURIComponent(fromPair[1]);
  if (/^\d+_[A-Za-z0-9]+$/.test(trimmed)) return trimmed;
  if (/^[A-Za-z0-9]{16,}$/.test(trimmed)) return trimmed;
  return null;
}

function buildPixivCookieHeader(input, phpSessId) {
  const trimmed = input.trim().replace(/^Cookie:\s*/i, "");
  const pairs = new Map();
  if (trimmed.includes("=")) {
    for (const part of trimmed.split(";")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (key) pairs.set(key, value);
    }
  }
  pairs.set("PHPSESSID", phpSessId);
  if (!pairs.has("privacy_policy_agreement")) pairs.set("privacy_policy_agreement", "7");
  return [...pairs.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function isLoggedInSess(phpSessId) {
  return /^\d+_[A-Za-z0-9]+$/.test(phpSessId);
}

function pixivHeaders(cookieHeader) {
  return {
    "User-Agent": DEFAULT_UA,
    Referer: PIXIV_REFERER,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7",
    Accept: "application/json",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    Cookie: cookieHeader,
  };
}

async function fetchPixiv(path, cookieHeader) {
  const url = path.startsWith("http") ? path : `https://www.pixiv.net${path}`;
  const res = await fetch(url, { headers: pixivHeaders(cookieHeader) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
  }
  return { status: res.status, url, text: text.slice(0, 500), json };
}

async function validateSession(input, phpSessId) {
  const cookieHeader = buildPixivCookieHeader(input, phpSessId);
  const userId = phpSessId.match(/^(\d+)_/)?.[1];
  if (!userId) throw new Error("无法从 PHPSESSID 解析用户 ID");

  const profile = await fetchPixiv(`/ajax/user/${userId}?full=1`, cookieHeader);
  console.log(`\n=== /ajax/user/${userId}?full=1 ===`);
  console.log("status:", profile.status);
  if (profile.json) console.log("body:", JSON.stringify(profile.json, null, 2));
  else console.log("raw:", profile.text);

  if (profile.status === 200 && profile.json?.body?.isLogin === true) {
    const body = profile.json.body;
    return { userId, userName: body.name || body.userName || `uid:${userId}` };
  }

  const extra = await fetchPixiv("/ajax/user/extra", cookieHeader);
  console.log("\n=== /ajax/user/extra (fallback) ===");
  console.log("status:", extra.status);
  if (extra.json) console.log("body:", JSON.stringify(extra.json, null, 2));
  else console.log("raw:", extra.text);

  if (extra.status === 401 || extra.status === 403) {
    const cf = /just a moment|cloudflare|challenge-platform/i.test(extra.text);
    throw new Error(
      cf
        ? "Pixiv Cloudflare 拦截（本机网络或机房 IP）"
        : `Pixiv 拒绝访问 ${extra.status}，登录态可能无效`,
    );
  }
  if (extra.status !== 200 || extra.json?.error) {
    throw new Error(extra.json?.message || `Pixiv 返回 ${extra.status}`);
  }

  const name = profile.json?.body?.name || profile.json?.body?.userName || `uid:${userId}`;
  return { userId, userName: name };
}

const input = process.argv[2] || process.env.PIXIV_COOKIE || "";
if (!input) {
  console.error("用法: node scripts/test-pixiv-session.mjs <PHPSESSID 或 Cookie>");
  process.exit(1);
}

const phpSessId = extractPhpSessId(input);
console.log("extracted PHPSESSID:", phpSessId);
console.log("looks logged-in:", isLoggedInSess(phpSessId || ""));

if (!phpSessId || !isLoggedInSess(phpSessId)) {
  console.error("无效的 PHPSESSID 格式");
  process.exit(1);
}

validateSession(input, phpSessId)
  .then((info) => {
    console.log("\n=== validateSession result ===");
    console.log(info);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
