import { describe, expect, it } from "vitest";
import { chatCompletionsUrl, splitNovelParagraphs } from "./text";

describe("splitNovelParagraphs", () => {
  it("splits on blank lines", () => {
    expect(splitNovelParagraphs("第一段\n\n第二段")).toEqual(["第一段", "第二段"]);
  });

  it("splits on [newpage]", () => {
    expect(splitNovelParagraphs("A[newpage]B")).toEqual(["A", "B"]);
  });

  it("drops empty chunks", () => {
    expect(splitNovelParagraphs("\n\nhello\n\n\n")).toEqual(["hello"]);
  });
});

describe("chatCompletionsUrl", () => {
  it("appends chat/completions", () => {
    expect(chatCompletionsUrl("https://api.deepseek.com/v1")).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
  });

  it("does not double-append", () => {
    expect(chatCompletionsUrl("https://api.openai.com/v1/chat/completions/")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });
});
