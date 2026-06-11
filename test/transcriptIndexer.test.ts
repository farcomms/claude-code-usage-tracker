import { describe, it, expect } from "vitest";
import { parseUsageLine, projectNameFromCwd } from "../src/transcriptIndexer";

const assistantLine = JSON.stringify({
  type: "assistant",
  timestamp: "2026-06-08T20:31:46.176Z",
  sessionId: "sess-1",
  requestId: "req_1",
  cwd: "/Users/u/FarDev/Chat-App",
  gitBranch: "main",
  message: {
    id: "msg_1",
    model: "claude-opus-4-8",
    usage: { input_tokens: 1978, output_tokens: 617, cache_read_input_tokens: 16760, cache_creation_input_tokens: 3205 },
  },
});

describe("projectNameFromCwd", () => {
  it("uses the last path segment", () => {
    expect(projectNameFromCwd("/Users/u/FarDev/Chat-App")).toBe("Chat-App");
    expect(projectNameFromCwd("/Users/u/FarDev/Chat-App/")).toBe("Chat-App");
    expect(projectNameFromCwd("")).toBe("(unknown)");
  });
});

describe("parseUsageLine", () => {
  it("parses an assistant usage record", () => {
    const r = parseUsageLine(assistantLine);
    expect(r).toMatchObject({
      requestId: "req_1", messageId: "msg_1", model: "claude-opus-4-8",
      sessionId: "sess-1", project: "Chat-App", projectPath: "/Users/u/FarDev/Chat-App",
      tokens: { input: 1978, output: 617, cacheRead: 16760, cacheCreation: 3205 },
    });
  });
  it("returns null for non-assistant lines", () => {
    expect(parseUsageLine(JSON.stringify({ type: "user", message: {} }))).toBeNull();
  });
  it("returns null for assistant lines without usage", () => {
    expect(parseUsageLine(JSON.stringify({ type: "assistant", message: { id: "m" } }))).toBeNull();
  });
  it("skips sidechain and meta records", () => {
    const side = JSON.parse(assistantLine); side.isSidechain = true;
    expect(parseUsageLine(JSON.stringify(side))).toBeNull();
  });
  it("returns null for malformed JSON", () => {
    expect(parseUsageLine("{not json")).toBeNull();
  });
});
