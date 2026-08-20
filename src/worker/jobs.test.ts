import { describe, expect, it } from "vitest";
import { isStaleJob, publicJob, relayAuthorized, STALE_JOB_MS, type JobRow } from "./jobs";

const base: JobRow = {
  id: "j1",
  type: "translate",
  status: "queued",
  work_id: 4,
  source_hash: "abc",
  target_lang: "zh-CN",
  result: "secret",
  error: null,
  created_at: 1,
  updated_at: 1,
};

describe("isStaleJob", () => {
  it("treats recent jobs as active", () => {
    expect(isStaleJob(1_000, 1_000 + 60_000)).toBe(false);
  });

  it("expires after the stale window", () => {
    expect(isStaleJob(1_000, 1_000 + STALE_JOB_MS + 1)).toBe(true);
  });
});

describe("publicJob", () => {
  it("only exposes translation when done", () => {
    expect(publicJob(base).translated).toBeUndefined();
    expect(publicJob({ ...base, status: "done", result: "译文" }).translated).toBe("译文");
  });
});

describe("relayAuthorized", () => {
  it("requires matching bearer secret", () => {
    expect(relayAuthorized("Bearer abc", "abc")).toBe(true);
    expect(relayAuthorized("Bearer no", "abc")).toBe(false);
    expect(relayAuthorized(undefined, "abc")).toBe(false);
  });
});
