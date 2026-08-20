import { describe, expect, it } from "vitest";
import { applyDeltas, parseSseChunk } from "./openai-stream.mjs";

describe("parseSseChunk", () => {
  it("extracts content deltas and keeps a partial line", () => {
    const first = parseSseChunk(
      "",
      'data: {"choices":[{"delta":{"content":"仓"}}]}\n\ndata: {"choices":[{"delta":{"content":"库"}}]}\ndata: {"choi',
    );
    expect(first.deltas.map((d) => d.content).join("")).toBe("仓库");
    expect(first.done).toBe(false);
    const second = parseSseChunk(first.rest, 'ces":[{"delta":{"content":"里"}}]}\ndata: [DONE]\n');
    expect(second.deltas.map((d) => d.content).join("")).toBe("里");
    expect(second.done).toBe(true);
  });

  it("reads reasoning from either field", () => {
    const a = parseSseChunk("", 'data: {"choices":[{"delta":{"reasoning":"想"}}]}\n');
    const b = parseSseChunk("", 'data: {"choices":[{"delta":{"reasoning_content":"一下"}}]}\n');
    expect(applyDeltas({ content: "", reasoning: "" }, [...a.deltas, ...b.deltas]).reasoning).toBe("想一下");
  });
});
