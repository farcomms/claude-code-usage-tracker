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

// ---------- Aggregations ----------
export interface CostedTotals {
  tokens: TokenCounts;
  totalTokens: number;
  cost: number;           // USD
  costKnown: boolean;     // false if any contributing model lacked pricing
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
}
export type FileIndex = Record<string, FileIndexEntry>;  // keyed by absolute file path
