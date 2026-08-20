import { listFiles, pixivUrlForWork, type WorkRow } from "./store";

export function publicWork(work: WorkRow, files?: Awaited<ReturnType<typeof listFiles>>) {
  const firstImage = files?.find((f) => f.content_type.startsWith("image/"));
  return {
    id: work.id,
    pixivId: work.pixiv_id,
    kind: work.kind,
    title: work.title,
    author: work.author,
    authorId: work.user_id,
    pageCount: work.page_count,
    xRestrict: work.x_restrict,
    restricted: Boolean(work.restricted),
    complete: Boolean(work.complete),
    fileCount: work.file_count,
    sourceUrl: pixivUrlForWork(work),
    thumb: firstImage
      ? `/api/file?key=${encodeURIComponent(firstImage.r2_key)}`
      : work.thumb_url
        ? `/api/proxy?u=${encodeURIComponent(work.thumb_url)}`
        : null,
    fetchedAt: work.fetched_at,
    files: files?.map((f) => ({
      page: f.page_index,
      filename: f.filename,
      key: f.r2_key,
      contentType: f.content_type,
      size: f.size,
    })),
  };
}
