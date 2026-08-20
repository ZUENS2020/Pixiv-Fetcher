import { describe, expect, it } from "vitest";
import { mcpError, mcpJson } from "./mcp-result";
import { PixivError } from "./pixiv";

describe("mcp helpers", () => {
  it("serializes JSON payloads", () => {
    const out = mcpJson({ ok: true, id: 1 });
    expect(out.content[0]?.text).toContain('"ok": true');
    expect(JSON.parse(out.content[0].text)).toEqual({ ok: true, id: 1 });
  });

  it("wraps PixivError as isError", () => {
    const out = mcpError(new PixivError("文库中没有该作品", 404, "not_found"));
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text)).toEqual({ error: "文库中没有该作品" });
  });
});
