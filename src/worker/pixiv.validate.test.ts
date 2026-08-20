import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./rate-limit", () => ({
  rateLimit: vi.fn(async () => true),
}));

import { PixivError, validateSession } from "./pixiv";

function ajaxOk(body: unknown): Response {
  return new Response(JSON.stringify({ error: false, body }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function ajaxAuthFail(status = 403, html = "forbidden"): Response {
  return new Response(html, { status });
}

const client = {
  request: new Request("http://127.0.0.1"),
  phpSessId: "12345678_testsession",
  cookieHeader: "PHPSESSID=12345678_testsession; privacy_policy_agreement=7",
};

describe("validateSession", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts when profile reports isLogin", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      ajaxOk({ name: "测试用户", isLogin: true, userId: "12345678" }),
    );

    await expect(validateSession(client)).resolves.toEqual({
      userId: "12345678",
      userName: "测试用户",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to /ajax/user/extra when profile is public-only", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(ajaxOk({ name: "公开用户", userId: "12345678" }))
      .mockResolvedValueOnce(ajaxOk({ pickup: [] }));

    await expect(validateSession(client)).resolves.toEqual({
      userId: "12345678",
      userName: "公开用户",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid session with clearer 403 message", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(ajaxAuthFail(403, "forbidden"))
      .mockResolvedValueOnce(ajaxAuthFail(403, "Just a moment... challenge-platform"));

    await expect(validateSession(client)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("Browser Rendering"),
    } satisfies Partial<PixivError>);
  });

  it("rejects malformed session id", async () => {
    await expect(
      validateSession({ ...client, phpSessId: "not_a_logged_in_sess" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("无法从 PHPSESSID 解析用户 ID"),
    });
  });
});
