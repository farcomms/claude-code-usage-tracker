import * as vscode from "vscode";
import { QuotaData, QuotaError, UsageSummary } from "../types";
import { Section } from "../treeProvider";

function nonce(): string {
  let s = ""; const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) { s += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return s;
}

export interface DashboardState {
  summary: UsageSummary | null;
  quota: QuotaData | null;
  error: QuotaError | null;
  section: Section;
  stale: boolean;
}

export class DashboardPanel {
  private panel: vscode.WebviewPanel | undefined;
  private section: Section = "overview";
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onRefresh: () => void,
    private readonly getState: () => Omit<DashboardState, "section">,
  ) {}

  show(section?: Section): void {
    if (section) { this.section = section; }
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Active); this.post(); return; }
    this.panel = vscode.window.createWebviewPanel("claudeUsage", "Claude Usage", vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    });
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.panel.webview.onDidReceiveMessage((m) => {
      if (m?.type === "refresh") { this.onRefresh(); }
      else if (m?.type === "navigate") { this.section = m.section; this.post(); }
    });
    this.post();
  }

  update(): void { if (this.panel) { this.post(); } }

  private post(): void {
    if (!this.panel) { return; }
    const s = this.getState();
    this.panel.webview.postMessage({ type: "state", section: this.section, ...s });
  }

  private html(webview: vscode.Webview): string {
    const fs = require("node:fs") as typeof import("node:fs");
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", f)).toString();
    const htmlPath = vscode.Uri.joinPath(this.extensionUri, "media", "dashboard.html").fsPath;
    const n = nonce();
    return fs.readFileSync(htmlPath, "utf8")
      .replace(/{{cspSource}}/g, webview.cspSource)
      .replace(/{{nonce}}/g, n)
      .replace(/{{cssUri}}/g, uri("dashboard.css"))
      .replace(/{{jsUri}}/g, uri("dashboard.js"));
  }

  dispose(): void { this.panel?.dispose(); }
}
