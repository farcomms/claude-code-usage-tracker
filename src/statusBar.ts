import * as vscode from "vscode";
import { QuotaData, QuotaError } from "./types";
import { statusBarText, utilizationColor, formatDuration, StatusMode } from "./format";

export class StatusBarManager {
  private item: vscode.StatusBarItem;
  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "claudeUsage.showDashboard";
  }

  update(quota: QuotaData | null, error: QuotaError | null): void {
    const cfg = vscode.workspace.getConfiguration("claudeUsage");
    const mode = cfg.get<StatusMode>("statusBar.mode", "5h");
    if (mode === "off") { this.item.hide(); return; }
    const colorFrom = cfg.get<"5h" | "7d" | "max">("statusBar.colorFrom", "5h");
    const now = new Date();

    if (!quota) {
      this.item.text = error?.kind === "no-token" ? "$(cloud) Log in to Claude Code" : "$(cloud) —";
    } else {
      this.item.text = statusBarText(quota, mode, now) + (error ? " $(warning)" : "");
    }
    const colorId = utilizationColor(quota, colorFrom);
    this.item.backgroundColor = colorId ? new vscode.ThemeColor(colorId) : undefined;
    this.item.tooltip = this.tooltip(quota, error, now);
    this.item.show();
  }

  private tooltip(q: QuotaData | null, error: QuotaError | null, now: Date): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown("**Claude Usage**\n\n");
    if (q) {
      const row = (label: string, b: { utilization: number; resetsAt: string | null } | null) =>
        b ? `- ${label}: ${Math.round(b.utilization)}% (resets in ${formatDuration(Date.parse(b.resetsAt ?? "") - now.getTime())})\n` : "";
      md.appendMarkdown(row("5-hour", q.fiveHour));
      md.appendMarkdown(row("7-day", q.sevenDay));
      md.appendMarkdown(row("7-day Opus", q.sevenDayOpus));
      md.appendMarkdown(row("7-day Sonnet", q.sevenDaySonnet));
    }
    if (error) { md.appendMarkdown(`\n_${error.message}_ (showing cached data)\n`); }
    md.appendMarkdown("\nClick to open the dashboard.");
    return md;
  }

  dispose(): void { this.item.dispose(); }
}
