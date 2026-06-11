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
const ICON = "$(cloud)";

export function statusBarText(q: QuotaData | null, mode: StatusMode, now: Date): string {
  if (!q) { return `${ICON} —`; }
  const fh = q.fiveHour, sd = q.sevenDay;
  if (mode === "7d" && sd) { return `${ICON} 7d ${Math.round(sd.utilization)}% · ${formatDuration(resetMs(sd.resetsAt, now))}`; }
  if (mode === "both") {
    const a = fh ? `5h ${Math.round(fh.utilization)}%` : "5h —";
    const b = sd ? `7d ${Math.round(sd.utilization)}%` : "7d —";
    return `${ICON} ${a} · ${b}`;
  }
  if (fh) { return `${ICON} ${Math.round(fh.utilization)}% · ${formatDuration(resetMs(fh.resetsAt, now))}`; }
  return `${ICON} —`;
}

export function utilizationColor(q: QuotaData | null, colorFrom: "5h" | "7d" | "max"): string | undefined {
  if (!q) { return undefined; }
  const fh = q.fiveHour?.utilization ?? 0, sd = q.sevenDay?.utilization ?? 0;
  const u = colorFrom === "7d" ? sd : colorFrom === "max" ? Math.max(fh, sd) : fh;
  if (u >= 80) { return "statusBarItem.errorBackground"; }
  if (u >= 60) { return "statusBarItem.warningBackground"; }
  return undefined;
}
