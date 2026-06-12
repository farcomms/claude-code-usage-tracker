import * as assert from "node:assert";
import * as vscode from "vscode";

suite("activation", () => {
  test("registers commands", async () => {
    const ext = vscode.extensions.getExtension("farcomms.claude-code-usage-tracker");
    assert.ok(ext, "extension present");
    await ext!.activate();
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes("claudeUsage.refresh"));
    assert.ok(cmds.includes("claudeUsage.showDashboard"));
    assert.ok(cmds.includes("claudeUsage.openSection"));
  });
});
