import { describe, it, expect } from "vitest";
import { findClaude, loginTerminal, installerCommand, installTerminal, CliDeps } from "../src/accounts/claudeCli";

function deps(over: Partial<CliDeps> & { files?: string[] }): CliDeps {
  const files = new Set(over.files ?? []);
  return {
    platform: "linux",
    env: {},
    homedir: () => "/home/u",
    exists: (p) => files.has(p),
    ...over,
  };
}

describe("findClaude", () => {
  it("finds claude on the PATH (POSIX)", () => {
    const d = deps({ env: { PATH: "/usr/bin:/opt/tools/bin" }, files: ["/opt/tools/bin/claude"] });
    expect(findClaude(d)).toBe("/opt/tools/bin/claude");
  });

  it("finds claude.exe or an npm claude.cmd on the Windows Path", () => {
    const home = "C:\\Users\\u";
    const exe = deps({ platform: "win32", homedir: () => home, env: { Path: "C:\\Windows;C:\\Tools\\" }, files: ["C:\\Tools\\claude.exe"] });
    expect(findClaude(exe)).toBe("C:\\Tools\\claude.exe");
    const cmd = deps({ platform: "win32", homedir: () => home, env: { PATH: "C:\\npm" }, files: ["C:\\npm\\claude.cmd"] });
    expect(findClaude(cmd)).toBe("C:\\npm\\claude.cmd");
  });

  it("falls back to the native installer's folder when it isn't on the PATH", () => {
    const win = deps({ platform: "win32", homedir: () => "C:\\Users\\u", env: { Path: "C:\\Windows" },
      files: ["C:\\Users\\u\\.local\\bin\\claude.exe"] });
    expect(findClaude(win)).toBe("C:\\Users\\u\\.local\\bin\\claude.exe");
    const mac = deps({ platform: "darwin", env: { PATH: "/usr/bin" }, files: ["/home/u/.local/bin/claude"] });
    expect(findClaude(mac)).toBe("/home/u/.local/bin/claude");
  });

  it("strips quotes around Windows Path entries", () => {
    const d = deps({ platform: "win32", homedir: () => "C:\\Users\\u", env: { Path: '"C:\\Program Files\\nodejs"' },
      files: ["C:\\Program Files\\nodejs\\claude.cmd"] });
    expect(findClaude(d)).toBe("C:\\Program Files\\nodejs\\claude.cmd");
  });

  it("finds the older ~/.claude/local install off Windows", () => {
    expect(findClaude(deps({ env: { PATH: "/usr/bin" }, files: ["/home/u/.claude/local/claude"] }))).toBe("/home/u/.claude/local/claude");
  });

  it("returns null when Claude Code isn't installed", () => {
    expect(findClaude(deps({ env: { PATH: "/usr/bin" } }))).toBeNull();
    expect(findClaude(deps({ platform: "win32", homedir: () => "C:\\Users\\u", env: {} }))).toBeNull();
  });

  it("ignores empty PATH entries", () => {
    expect(findClaude(deps({ env: { PATH: "::/usr/bin" }, files: ["claude"] }))).toBeNull();
  });
});

describe("loginTerminal", () => {
  it("on Windows runs the full path in PowerShell, quoting single quotes", () => {
    expect(loginTerminal("C:\\Users\\O'Neil\\.local\\bin\\claude.exe", "win32"))
      .toEqual({ shellPath: "powershell.exe", text: "& 'C:\\Users\\O''Neil\\.local\\bin\\claude.exe' /login" });
  });
  it("elsewhere runs claude itself as the terminal's program, so the default shell doesn't matter", () => {
    expect(loginTerminal("/home/o'neil/.local/bin/claude", "darwin"))
      .toEqual({ shellPath: "/home/o'neil/.local/bin/claude", shellArgs: ["/login"] });
  });
});

describe("install commands", () => {
  it("uses Anthropic's official installers", () => {
    expect(installerCommand("win32")).toBe("irm https://claude.ai/install.ps1 | iex");
    expect(installerCommand("darwin")).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(installerCommand("linux")).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  });

  it("on Windows installs in PowerShell, then fixes the user Path and logs in only if claude.exe exists", () => {
    const t = installTerminal("win32");
    expect(t.shellPath).toBe("powershell.exe");
    expect(t.text!.startsWith("irm https://claude.ai/install.ps1 | iex; $b = \"$env:USERPROFILE\\.local\\bin\"; if (Test-Path \"$b\\claude.exe\") { ")).toBe(true);
    expect(t.text).toContain("} else { Write-Host");
    expect(t.text!.indexOf("& \"$b\\claude.exe\" /login")).toBeLessThan(t.text!.indexOf("} else {"));
  });

  it("on Windows edits the raw registry Path so %VARS% survive, only when the folder is missing", () => {
    const t = installTerminal("win32").text!;
    expect(t).toContain("DoNotExpandEnvironmentNames");
    expect(t).toContain("RegistryValueKind]::ExpandString");
    expect(t).toContain("if ($have -notcontains $b)");
    expect(t).toContain("ExpandEnvironmentVariables($_.Trim().Trim('\"')).TrimEnd('\\')");
    expect(t).not.toContain("GetEnvironmentVariable('Path'");
  });

  it("elsewhere installs in bash, then logs in only if the binary is there", () => {
    const t = installTerminal("darwin");
    expect(t.shellPath).toBe("bash");
    expect(t.env).toEqual({ BASH_SILENCE_DEPRECATION_WARNING: "1" });
    expect(t.text).toBe("curl -fsSL https://claude.ai/install.sh | bash && [ -x \"$HOME/.local/bin/claude\" ] && \"$HOME/.local/bin/claude\" /login"
      + " || echo \"Claude Code didn't install. See the messages above, or follow https://code.claude.com/docs/en/setup\"");
  });
});
