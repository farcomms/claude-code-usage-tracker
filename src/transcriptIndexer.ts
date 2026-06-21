import { UsageRecord, EditRecord, FileIndexEntry } from "./types";

/** Count lines in a chunk of text (a non-empty unterminated last line counts). */
export function countLines(s: string): number {
  if (!s) { return 0; }
  const n = s.split("\n").length;
  return s.endsWith("\n") ? n - 1 : n;
}

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".kts",
  ".rb", ".php", ".cs", ".c", ".cc", ".cpp", ".h", ".hpp", ".m", ".mm", ".swift", ".dart",
  ".scala", ".sh", ".bash", ".zsh", ".css", ".scss", ".sass", ".less", ".vue", ".svelte",
  ".sql", ".lua", ".r", ".jl", ".ex", ".exs", ".clj", ".hs", ".ml", ".pl", ".ps1",
]);
function extOf(p: string): string {
  const base = (p || "").split("/").pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
function editLines(tool: string, input: any): { path: string; added: number; removed: number } {
  if (tool === "Write") {
    return { path: input.file_path ?? "", added: countLines(input.content ?? ""), removed: 0 };
  }
  if (tool === "Edit") {
    return { path: input.file_path ?? "", added: countLines(input.new_string ?? ""), removed: countLines(input.old_string ?? "") };
  }
  if (tool === "MultiEdit") {
    let a = 0, r = 0;
    for (const e of input.edits ?? []) { a += countLines(e.new_string ?? ""); r += countLines(e.old_string ?? ""); }
    return { path: input.file_path ?? "", added: a, removed: r };
  }
  return { path: input.notebook_path ?? "", added: countLines(input.new_source ?? ""), removed: 0 };
}

/**
 * Extract file-writing tool calls and any error/rejection results from one line.
 * Returns `edits` (one per Write/Edit/MultiEdit/NotebookEdit tool_use) and
 * `errorIds` (tool_use ids whose tool_result was an error/rejection — these are
 * excluded at aggregation time, matching "lines of code accepted").
 */
export function parseEditsLine(line: string): { edits: EditRecord[]; errorIds: string[] } {
  const out: { edits: EditRecord[]; errorIds: string[] } = { edits: [], errorIds: [] };
  let d: any;
  try { d = JSON.parse(line); } catch { return out; }
  if (!d || d.isSidechain || d.isMeta) { return out; }
  const content = d.message?.content;
  if (!Array.isArray(content)) { return out; }
  const cwd = typeof d.cwd === "string" ? d.cwd : "";
  for (const blk of content) {
    if (!blk || typeof blk !== "object") { continue; }
    if (blk.type === "tool_result") {
      if (blk.is_error && typeof blk.tool_use_id === "string") { out.errorIds.push(blk.tool_use_id); }
      continue;
    }
    if (blk.type !== "tool_use" || !EDIT_TOOLS.has(blk.name) || typeof blk.id !== "string") { continue; }
    const { path, added, removed } = editLines(blk.name, blk.input ?? {});
    const ext = extOf(path);
    out.edits.push({
      toolUseId: blk.id,
      model: d.message?.model ?? "unknown",
      timestamp: d.timestamp ?? "",
      project: projectNameFromCwd(cwd),
      projectPath: cwd,
      sessionId: d.sessionId ?? "",
      ext,
      isCode: CODE_EXTS.has(ext),
      linesAdded: added,
      linesRemoved: removed,
    });
  }
  return out;
}

export function projectNameFromCwd(cwd: string): string {
  if (!cwd) { return "(unknown)"; }
  const parts = cwd.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "(unknown)";
}

export function parseUsageLine(line: string): UsageRecord | null {
  let d: any;
  try { d = JSON.parse(line); } catch { return null; }
  if (!d || d.type !== "assistant" || d.isSidechain || d.isMeta) { return null; }
  if (d.message?.model === "<synthetic>") { return null; }
  const u = d.message?.usage;
  if (!u || typeof u.output_tokens !== "number") { return null; }
  const cwd = typeof d.cwd === "string" ? d.cwd : "";
  return {
    requestId: d.requestId ?? d.message?.id ?? "",
    messageId: d.message?.id ?? null,
    model: d.message?.model ?? "unknown",
    timestamp: d.timestamp ?? "",
    project: projectNameFromCwd(cwd),
    projectPath: cwd,
    sessionId: d.sessionId ?? "",
    tokens: {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreation: u.cache_creation_input_tokens ?? 0,
    },
  };
}

export interface FileStat { size: number; mtimeMs: number; }

function dedupKey(r: { requestId: string; messageId: string | null }): string {
  return `${r.requestId}|${r.messageId ?? ""}`;
}

/**
 * Update (or create) the per-file index entry.
 * `readFrom(offset)` returns the file text starting at `offset` (UTF-8).
 * Only whole newline-terminated lines are consumed; a trailing partial line is left for next time.
 */
export function indexFile(
  prev: FileIndexEntry | null,
  stat: FileStat,
  readFrom: (offset: number) => string,
): FileIndexEntry {
  // Detect truncation/rotation: file shrank below our offset -> start over.
  const startFresh = !prev || stat.size < prev.offset;
  const base: FileIndexEntry = startFresh
    ? { size: 0, mtimeMs: 0, offset: 0, seenIds: [], records: [], edits: [], errorIds: [], seenEditIds: [] }
    : {
        ...prev!,
        seenIds: [...prev!.seenIds], records: [...prev!.records],
        edits: [...(prev!.edits ?? [])], errorIds: [...(prev!.errorIds ?? [])],
        seenEditIds: [...(prev!.seenEditIds ?? [])],
      };

  if (!startFresh && stat.size === base.offset && stat.mtimeMs === base.mtimeMs) {
    return { ...base, size: stat.size, mtimeMs: stat.mtimeMs }; // nothing new
  }

  const text = readFrom(base.offset);
  const lastNl = text.lastIndexOf("\n");
  const consumable = lastNl >= 0 ? text.slice(0, lastNl + 1) : "";
  const consumedBytes = Buffer.byteLength(consumable, "utf8");

  const seen = new Set(base.seenIds);
  const seenEdits = new Set(base.seenEditIds);
  const errSet = new Set(base.errorIds);
  for (const raw of consumable.split("\n")) {
    if (!raw) { continue; }
    const rec = parseUsageLine(raw);
    if (rec) {
      const key = dedupKey(rec);
      if (!seen.has(key)) { seen.add(key); base.records.push(rec); }
    }
    const { edits, errorIds } = parseEditsLine(raw);
    for (const e of edits) {
      if (seenEdits.has(e.toolUseId)) { continue; }
      seenEdits.add(e.toolUseId);
      base.edits.push(e);
    }
    for (const id of errorIds) { errSet.add(id); }
  }

  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    offset: base.offset + consumedBytes,
    seenIds: Array.from(seen),
    records: base.records,
    edits: base.edits,
    errorIds: Array.from(errSet),
    seenEditIds: Array.from(seenEdits),
  };
}

/** Production helper: read a file slice from a byte offset. */
export function readFileFrom(path: string, offset: number): string {
  const fs = require("node:fs") as typeof import("node:fs");
  const fd = fs.openSync(path, "r");
  try {
    const stat = fs.fstatSync(fd);
    const len = Math.max(0, stat.size - offset);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    return buf.toString("utf8");
  } finally { fs.closeSync(fd); }
}

/** Production helper: enumerate transcript files under ~/.claude/projects. */
export function discoverTranscripts(projectsDir: string): string[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const out: string[] = [];
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(projectsDir); } catch { return out; }
  for (const d of dirs) {
    const full = path.join(projectsDir, d);
    try {
      if (!fs.statSync(full).isDirectory()) { continue; }
      for (const f of fs.readdirSync(full)) {
        if (f.endsWith(".jsonl")) { out.push(path.join(full, f)); }
      }
    } catch { /* skip unreadable dir */ }
  }
  return out;
}
