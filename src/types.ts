// ---------- Official quota (api/oauth/usage) ----------
export interface QuotaBucket {
  utilization: number;        // 0-100
  resetsAt: string | null;    // ISO 8601
}
export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null; // cents
  usedCredits: number | null;  // cents
  utilization: number | null;
  currency: string | null;
}
export interface QuotaData {
  fiveHour: QuotaBucket | null;
  sevenDay: QuotaBucket | null;
  sevenDaySonnet: QuotaBucket | null;
  sevenDayOpus: QuotaBucket | null;
  sevenDayOauthApps: QuotaBucket | null;
  extraUsage: ExtraUsage | null;
  fetchedAt: string;          // ISO
}
export type QuotaErrorKind = "no-token" | "unauthorized" | "forbidden" | "rate-limited" | "network" | "bad-response";
export interface QuotaError { kind: QuotaErrorKind; message: string; }
export type QuotaResult = { ok: true; data: QuotaData } | { ok: false; error: QuotaError };

// ---------- Local transcript usage ----------
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}
export interface UsageRecord {
  requestId: string;
  messageId: string | null;
  model: string;
  timestamp: string;      // ISO
  project: string;        // display name
  projectPath: string;    // cwd
  sessionId: string;
  tokens: TokenCounts;
}

/**
 * A single file-writing tool call (Write/Edit/MultiEdit/NotebookEdit) by Claude.
 * Replicates Anthropic's "lines of code accepted" metric: counted at acceptance
 * time, excluding rejected/errored calls (see `EditIndex.errorIds`). `linesAdded`
 * is gross authored lines (Write content / Edit+MultiEdit new_string), not a diff.
 */
export interface EditRecord {
  toolUseId: string;
  model: string;
  timestamp: string;      // ISO
  project: string;        // display name
  projectPath: string;    // cwd
  sessionId: string;
  ext: string;            // lowercased file extension incl. dot, or ""
  isCode: boolean;        // ext is a recognized code/source extension
  linesAdded: number;
  linesRemoved: number;
}

// ---------- Aggregations ----------
export interface CostedTotals {
  tokens: TokenCounts;
  totalTokens: number;
  cost: number;           // USD
  costKnown: boolean;     // false if any contributing model lacked pricing
  linesAdded: number;     // gross lines authored (accepted edits), all file types
  linesRemoved: number;   // gross lines removed (accepted edits)
  linesAddedCode: number; // subset of linesAdded in recognized code extensions
}
export interface ProjectRollup extends CostedTotals { project: string; projectPath: string; lastActive: string; }
export interface ModelRollup extends CostedTotals { model: string; }
export interface DayRollup extends CostedTotals { day: string; }   // YYYY-MM-DD
export interface SessionRollup extends CostedTotals {
  sessionId: string; project: string; start: string; end: string; messages: number;
}
export interface UsageSummary {
  totals: CostedTotals;
  today: CostedTotals;
  week: CostedTotals;
  month: CostedTotals;
  byProject: ProjectRollup[];
  byModel: ModelRollup[];
  byDay: DayRollup[];
  sessions: SessionRollup[];
}

// ---------- Pricing ----------
export interface ModelPrice {
  input: number;          // USD per token
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export type PriceMap = Record<string, ModelPrice>;

// ---------- Persisted incremental index (per file) ----------
export interface FileIndexEntry {
  size: number;
  mtimeMs: number;
  offset: number;             // bytes parsed so far
  seenIds: string[];          // dedup keys seen in this file
  records: UsageRecord[];     // deduped usage records from this file
  edits: EditRecord[];        // deduped file-writing tool calls from this file
  errorIds: string[];         // tool_use ids whose result was an error/rejection
  seenEditIds: string[];      // tool_use ids already captured (dedup)
}
export type FileIndex = Record<string, FileIndexEntry>;  // keyed by absolute file path
