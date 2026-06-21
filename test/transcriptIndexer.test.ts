import { describe, it, expect } from "vitest";
import { parseUsageLine, projectNameFromCwd, countLines, parseEditsLine } from "../src/transcriptIndexer";

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
  it("returns null for <synthetic> sentinel records", () => {
    const synthetic = JSON.parse(assistantLine);
    synthetic.message.model = "<synthetic>";
    expect(parseUsageLine(JSON.stringify(synthetic))).toBeNull();
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

describe("countLines", () => {
  it("counts content lines, ignoring a single trailing newline", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("a\nb\nc\n")).toBe(3);
    expect(countLines("\n")).toBe(1); // one empty line then terminator
  });
});

function toolUseLine(blocks: any[], over: any = {}): string {
  return JSON.stringify({
    type: "assistant", timestamp: "2026-06-11T10:00:00Z", sessionId: "s",
    cwd: "/Users/u/Proj", message: { id: "m", model: "claude-opus-4-8", content: blocks }, ...over,
  });
}

describe("parseEditsLine", () => {
  it("counts Write content as added lines with code detection", () => {
    const { edits } = parseEditsLine(toolUseLine([
      { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/p/a.ts", content: "x\ny\nz" } },
    ]));
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ toolUseId: "t1", model: "claude-opus-4-8", project: "Proj", ext: ".ts", isCode: true, linesAdded: 3, linesRemoved: 0 });
  });

  it("counts Edit new_string/old_string and flags markdown as non-code", () => {
    const { edits } = parseEditsLine(toolUseLine([
      { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/p/readme.md", old_string: "a", new_string: "a\nb\nc" } },
    ]));
    expect(edits[0]).toMatchObject({ ext: ".md", isCode: false, linesAdded: 3, linesRemoved: 1 });
  });

  it("sums MultiEdit edits", () => {
    const { edits } = parseEditsLine(toolUseLine([
      { type: "tool_use", id: "t3", name: "MultiEdit", input: { file_path: "/p/a.py", edits: [
        { old_string: "x", new_string: "x\ny" }, { old_string: "p\nq", new_string: "p" },
      ] } },
    ]));
    expect(edits[0]).toMatchObject({ isCode: true, linesAdded: 3, linesRemoved: 3 });
  });

  it("captures error/rejection results as errorIds and ignores non-edit tools", () => {
    const r = parseEditsLine(toolUseLine([
      { type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "read1", name: "Read", input: { file_path: "/p/a.ts" } },
    ], { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "t9", is_error: true, content: "rejected" },
      { type: "tool_result", tool_use_id: "tok", is_error: false, content: "ok" },
    ] } }));
    expect(r.edits).toHaveLength(0);
    expect(r.errorIds).toEqual(["t9"]);
  });

  it("skips sidechain records", () => {
    const r = parseEditsLine(toolUseLine([
      { type: "tool_use", id: "t4", name: "Write", input: { file_path: "/p/a.ts", content: "x" } },
    ], { isSidechain: true }));
    expect(r.edits).toHaveLength(0);
  });
});

describe("indexFile", () => {
  const stat = (size: number): FileStat => ({ size, mtimeMs: size });

  it("captures edits, dedups by toolUseId, and collects errorIds", () => {
    const w = toolUseLine([{ type: "tool_use", id: "e1", name: "Write", input: { file_path: "/p/a.ts", content: "1\n2\n3" } }]);
    const dup = toolUseLine([{ type: "tool_use", id: "e1", name: "Write", input: { file_path: "/p/a.ts", content: "1\n2\n3" } }]);
    const err = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e1", is_error: true }] } });
    const text = [w, dup, err].join("\n") + "\n";
    const entry = indexFile(null, stat(text.length), () => text);
    expect(entry.edits.map((e) => e.toolUseId)).toEqual(["e1"]);
    expect(entry.edits[0].linesAdded).toBe(3);
    expect(entry.errorIds).toEqual(["e1"]);
  });

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
