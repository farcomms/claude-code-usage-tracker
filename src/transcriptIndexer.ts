import { UsageRecord, FileIndexEntry } from "./types";

export function projectNameFromCwd(cwd: string): string {
  if (!cwd) { return "(unknown)"; }
  const parts = cwd.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "(unknown)";
}

export function parseUsageLine(line: string): UsageRecord | null {
  let d: any;
  try { d = JSON.parse(line); } catch { return null; }
  if (!d || d.type !== "assistant" || d.isSidechain || d.isMeta) { return null; }
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
    ? { size: 0, mtimeMs: 0, offset: 0, seenIds: [], records: [] }
    : { ...prev, seenIds: [...prev.seenIds], records: [...prev.records] };

  if (!startFresh && stat.size === base.offset && stat.mtimeMs === base.mtimeMs) {
    return { ...base, size: stat.size, mtimeMs: stat.mtimeMs }; // nothing new
  }

  const text = readFrom(base.offset);
  const lastNl = text.lastIndexOf("\n");
  const consumable = lastNl >= 0 ? text.slice(0, lastNl + 1) : "";
  const consumedBytes = Buffer.byteLength(consumable, "utf8");

  const seen = new Set(base.seenIds);
  for (const raw of consumable.split("\n")) {
    if (!raw) { continue; }
    const rec = parseUsageLine(raw);
    if (!rec) { continue; }
    const key = dedupKey(rec);
    if (seen.has(key)) { continue; }
    seen.add(key);
    base.records.push(rec);
  }

  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    offset: base.offset + consumedBytes,
    seenIds: Array.from(seen),
    records: base.records,
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
