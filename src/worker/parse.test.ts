import { describe, expect, it } from "vitest";
import { extractPixivUrls, parsePixivUrl } from "./parse";

describe("extractPixivUrls", () => {
  it("finds a URL glued to Chinese share text", () => {
    expect(
      extractPixivUrls("手机分享：超好看https://www.pixiv.net/artworks/12345必看"),
    ).toEqual(["https://www.pixiv.net/artworks/12345"]);
  });

  it("splits mixed titles, hashtags, and several links", () => {
    const blob = `黄昏のキャラバン | 作者A - pixiv
#pixiv #イラスト
https://www.pixiv.net/artworks/111
再看这篇小说https://www.pixiv.net/novel/show.php?id=222。
以及用户页 https://www.pixiv.net/users/333`;
    expect(extractPixivUrls(blob)).toEqual([
      "https://www.pixiv.net/artworks/111",
      "https://www.pixiv.net/novel/show.php?id=222",
      "https://www.pixiv.net/users/333",
    ]);
  });

  it("accepts scheme-less and quoted links, ignores other sites", () => {
    expect(
      extractPixivUrls('看看「www.pixiv.net/artworks/9」还有 https://example.com/x'),
    ).toEqual(["https://www.pixiv.net/artworks/9"]);
  });

  it("dedupes the same work with /en/ prefix", () => {
    expect(
      extractPixivUrls(
        "https://www.pixiv.net/artworks/55\nhttps://www.pixiv.net/en/artworks/55",
      ),
    ).toEqual(["https://www.pixiv.net/artworks/55"]);
  });
});

describe("parsePixivUrl", () => {
  it("parses novel show.php", () => {
    expect(parsePixivUrl("https://www.pixiv.net/novel/show.php?id=23260307")).toEqual({
      kind: "novel",
      id: "23260307",
      unlisted: false,
    });
  });
});
