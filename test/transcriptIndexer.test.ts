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

import { indexFile, FileStat } from "../src/transcriptIndexer";
import { FileIndexEntry } from "../src/types";

function line(reqId: string, out = 10): string {
  return JSON.stringify({
    type: "assistant", timestamp: "2026-06-08T20:31:46Z", sessionId: "s", requestId: reqId,
    cwd: "/Users/u/Proj", message: { id: reqId + "-m", model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: out } },
  });
}

describe("indexFile", () => {
  const stat = (size: number): FileStat => ({ size, mtimeMs: size });

  it("parses a fresh file and dedups duplicate requestIds", () => {
    const text = [line("req_1"), line("req_1"), line("req_2")].join("\n") + "\n";
    const entry = indexFile(null, stat(text.length), () => text);
    expect(entry.records.map((r) => r.requestId)).toEqual(["req_1", "req_2"]);
    expect(entry.offset).toBe(text.length);
  });

  it("only reads appended bytes on subsequent calls", () => {
    const first = [line("req_1")].join("\n") + "\n";
    const e1 = indexFile(null, stat(first.length), () => first);
    const appended = [line("req_2")].join("\n") + "\n";
    const total = first + appended;
    let readFromOffset = -1;
    const e2 = indexFile(e1, stat(total.length), (off) => { readFromOffset = off; return appended; });
    expect(readFromOffset).toBe(first.length);
    expect(e2.records.map((r) => r.requestId)).toEqual(["req_1", "req_2"]);
  });

  it("re-reads the whole file if it shrank or mtime is unexpected (rotation)", () => {
    const first = [line("req_1"), line("req_2")].join("\n") + "\n";
    const e1 = indexFile(null, stat(first.length), () => first);
    const replaced = [line("req_9")].join("\n") + "\n";
    const e2 = indexFile(e1, { size: replaced.length, mtimeMs: 999999 }, () => replaced);
    expect(e2.records.map((r) => r.requestId)).toEqual(["req_9"]);
    expect(e2.offset).toBe(replaced.length);
  });

  it("ignores a trailing partial line (no newline yet)", () => {
    const text = line("req_1") + "\n" + line("req_2"); // req_2 has no trailing newline
    const entry = indexFile(null, stat(text.length), () => text);
    expect(entry.records.map((r) => r.requestId)).toEqual(["req_1"]);
    // offset advances only past the last complete newline
    expect(entry.offset).toBe(line("req_1").length + 1);
  });
});
