import * as vscode from "vscode";
import { QuotaData, UsageSummary } from "./types";
import { formatUsd, formatTokens } from "./format";

export type Section = "overview" | "projects" | "models" | "quota" | "sessions";

class SectionNode extends vscode.TreeItem {
  constructor(public section: Section, label: string, description: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.command = { command: "claudeUsage.openSection", title: "Open", arguments: [section] };
    this.iconPath = new vscode.ThemeIcon(
      section === "quota" ? "dashboard" : section === "sessions" ? "history" :
      section === "projects" ? "folder" : section === "models" ? "symbol-class" : "graph",
    );
  }
}

export class UsageTreeProvider implements vscode.TreeDataProvider<SectionNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private summary: UsageSummary | null = null;
  private quota: QuotaData | null = null;

  setData(summary: UsageSummary | null, quota: QuotaData | null): void {
    this.summary = summary; this.quota = quota; this._onDidChange.fire();
  }
  getTreeItem(e: SectionNode): vscode.TreeItem { return e; }
  getChildren(): SectionNode[] {
    const s = this.summary;
    const fh = this.quota?.fiveHour ? `${Math.round(this.quota.fiveHour.utilization)}%` : "—";
    return [
      new SectionNode("overview", "Overview", s ? `${formatUsd(s.totals.cost)} · ${formatTokens(s.totals.totalTokens)}` : ""),
      new SectionNode("projects", "By project", s ? `${s.byProject.length}` : ""),
      new SectionNode("models", "By model", s ? `${s.byModel.length}` : ""),
      new SectionNode("quota", "Quota", fh),
      new SectionNode("sessions", "Sessions", s ? `${s.sessions.length}` : ""),
    ];
  }
}
