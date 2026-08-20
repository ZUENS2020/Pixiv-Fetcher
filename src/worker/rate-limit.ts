export async function rateLimit(
  request: Request,
  bucket: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const slot = Math.floor(Date.now() / 1000 / windowSec);
  const key = new Request(`https://pixiv-fetcher.rate/${bucket}/${ip}/${slot}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  const count = hit ? Number(await hit.text()) : 0;
  if (count >= limit) return false;
  await cache.put(
    key,
    new Response(String(count + 1), {
      headers: { "Cache-Control": `max-age=${windowSec + 5}` },
    }),
  );
  return true;
}
