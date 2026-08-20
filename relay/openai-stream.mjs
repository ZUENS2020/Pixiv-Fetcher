/**
 * Parse OpenAI-compatible SSE and collect text deltas.
 * Shared by the relay so the Worker-side tests can lock the contract.
 */

export function parseSseChunk(buffer, chunkText) {
  const buf = `${buffer}${chunkText}`;
  const lines = buf.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  const deltas = [];
  let done = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    try {
      const json = JSON.parse(data);
      const delta = json.choices?.[0]?.delta || {};
      const content = typeof delta.content === "string" ? delta.content : "";
      const reasoning =
        (typeof delta.reasoning === "string" && delta.reasoning) ||
        (typeof delta.reasoning_content === "string" && delta.reasoning_content) ||
        "";
      if (content || reasoning) deltas.push({ content, reasoning });
    } catch {
      /* incomplete JSON line stays in rest via split; ignore malformed */
    }
  }
  return { rest, deltas, done };
}

export function applyDeltas(acc, deltas) {
  let content = acc.content || "";
  let reasoning = acc.reasoning || "";
  for (const d of deltas) {
    if (d.content) content += d.content;
    if (d.reasoning) reasoning += d.reasoning;
  }
  return { content, reasoning };
}
