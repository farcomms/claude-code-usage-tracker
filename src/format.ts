import { QuotaData } from "./types";

export function formatDuration(ms: number): string {
  if (ms <= 0) { return "now"; }
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
export function formatUsd(v: number): string { return `$${v.toFixed(2)}`; }
export function formatTokens(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
  return String(n);
}

function resetMs(resetsAt: string | null, now: Date): number {
  if (!resetsAt) { return 0; }
  return Date.parse(resetsAt) - now.getTime();
}

export type StatusMode = "5h" | "7d" | "both" | "off";
const ICON = "$(claude-logo)";

export function statusBarText(q: QuotaData | null, mode: StatusMode, now: Date): string {
  if (!q) { return `${ICON} —`; }
  const fh = q.fiveHour, sd = q.sevenDay;
  if (mode === "7d" && sd) { return `${ICON} 7d ${Math.round(sd.utilization)}% · ${formatDuration(resetMs(sd.resetsAt, now))}`; }
  if (mode === "both") {
    const a = fh ? `5h ${Math.round(fh.utilization)}%` : "5h —";
    const b = sd ? `7d ${Math.round(sd.utilization)}%` : "7d —";
    return `${ICON} ${a} · ${b}`;
  }
  if (fh) {
    const weekly = sd ? ` · ${Math.round(sd.utilization)}%` : "";
    return `${ICON} ${Math.round(fh.utilization)}% · ${formatDuration(resetMs(fh.resetsAt, now))}${weekly}`;
  }
  return `${ICON} —`;
}

// Milliseconds since the quota snapshot was fetched; Infinity when there is
// no snapshot (or an unparsable timestamp), so callers always treat it as due.
export function quotaAgeMs(q: QuotaData | null, now: Date): number {
  if (!q) { return Infinity; }
  const t = Date.parse(q.fetchedAt);
  return Number.isFinite(t) ? now.getTime() - t : Infinity;
}

// The item renders as a filled badge whenever quota data is available: the
// warning background (recolorable to Claude orange via colorCustomizations)
// is the everyday state; the error background takes over at >=80% so the
// alarm state still stands apart. These two are the only backgrounds the
// StatusBarItem API supports.
export function utilizationColor(q: QuotaData | null, colorFrom: "5h" | "7d" | "max"): string | undefined {
  if (!q) { return undefined; }
  const fh = q.fiveHour?.utilization ?? 0, sd = q.sevenDay?.utilization ?? 0;
  const u = colorFrom === "7d" ? sd : colorFrom === "max" ? Math.max(fh, sd) : fh;
  if (u >= 80) { return "statusBarItem.errorBackground"; }
  return "statusBarItem.warningBackground";
}

export type AccountDisplay = "email" | "name" | "off";
type AccountNames = { email: string; displayName: string | null };
type AccountDetails = { displayName: string | null; organizationName: string | null; subscriptionType: string | null };

/** Status-bar text for the account item, or null when it should be hidden. */
export function accountLabel(meta: AccountNames | null, mode: AccountDisplay): string | null {
  if (mode === "off") { return null; }
  if (!meta) { return "$(account) Not logged in"; }
  return `$(account) ${mode === "name" ? (meta.displayName ?? meta.email) : meta.email}`;
}

/** "Your Name · Personal · Max", skipping blanks. */
export function accountDetail(m: AccountDetails): string {
  const plan = m.subscriptionType ? m.subscriptionType[0].toUpperCase() + m.subscriptionType.slice(1) : null;
  return [m.displayName, m.organizationName, plan].filter(Boolean).join(" · ");
}

export function formatAgo(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) { return "just now"; }
  if (mins < 60) { return `${mins}m ago`; }
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

// A cached snapshot tagged with a different account belongs to the previous
// login: hide it until the active account's quota arrives. Untagged (pre-0.3.0)
// snapshots, and any snapshot while nobody is logged in, are shown as before.
export function quotaForAccount(q: QuotaData | null, activeUuid: string | null): QuotaData | null {
  if (!q || !q.accountUuid || !activeUuid) { return q; }
  return q.accountUuid === activeUuid ? q : null;
}
