import { UsageRecord } from "./types";

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
