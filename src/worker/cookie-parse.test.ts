import { describe, expect, it } from "vitest";
import {
  buildPixivCookieHeader,
  extractPhpSessId,
  isLoggedInSess,
  userIdFromSess,
} from "./cookie-parse";

describe("extractPhpSessId", () => {
  it("parses bare logged-in session", () => {
    expect(extractPhpSessId("12345678_abcdefghijklmnopqrstuvwxyz012345")).toBe(
      "12345678_abcdefghijklmnopqrstuvwxyz012345",
    );
  });

  it("parses PHPSESSID pair", () => {
    expect(extractPhpSessId("PHPSESSID=12345678_abc; path=/")).toBe("12345678_abc");
  });

  it("parses Cookie: prefix", () => {
    expect(extractPhpSessId("Cookie: PHPSESSID=12345678_abc")).toBe("12345678_abc");
  });
});

describe("buildPixivCookieHeader", () => {
  it("adds privacy_policy_agreement for bare session", () => {
    expect(buildPixivCookieHeader("12345678_abc", "12345678_abc")).toBe(
      "PHPSESSID=12345678_abc; privacy_policy_agreement=7",
    );
  });

  it("keeps extra cookies from pasted header", () => {
    const raw =
      "PHPSESSID=12345678_abc; b_type=1; privacy_policy_agreement=7; c_type=0";
    expect(buildPixivCookieHeader(raw, "12345678_abc")).toContain("b_type=1");
    expect(buildPixivCookieHeader(raw, "12345678_abc")).toContain(
      "PHPSESSID=12345678_abc",
    );
  });

  it("overwrites PHPSESSID when pasted value differs", () => {
    const out = buildPixivCookieHeader("PHPSESSID=old_value", "12345678_abc");
    expect(out).toContain("PHPSESSID=12345678_abc");
    expect(out).not.toContain("old_value");
  });
});

describe("session helpers", () => {
  it("detects logged-in format", () => {
    expect(isLoggedInSess("12345678_abc")).toBe(true);
    expect(isLoggedInSess("u6sj3qf5fu976467ehd0323dlgrvcp8c")).toBe(false);
  });

  it("extracts user id", () => {
    expect(userIdFromSess("12345678_abc")).toBe("12345678");
  });
});
