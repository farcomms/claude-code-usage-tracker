import { describe, it, expect } from "vitest";
import { findClaude, loginCommand, installerCommand, installAndLoginCommand, CliDeps } from "../src/accounts/claudeCli";

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

  it("returns null when Claude Code isn't installed", () => {
    expect(findClaude(deps({ env: { PATH: "/usr/bin" } }))).toBeNull();
    expect(findClaude(deps({ platform: "win32", homedir: () => "C:\\Users\\u", env: {} }))).toBeNull();
  });

  it("ignores empty PATH entries", () => {
    expect(findClaude(deps({ env: { PATH: "::/usr/bin" }, files: ["claude"] }))).toBeNull();
  });
});

describe("loginCommand", () => {
  it("runs the full path with PowerShell's call operator on Windows, quoting single quotes", () => {
    expect(loginCommand("C:\\Users\\O'Neil\\.local\\bin\\claude.exe", "win32"))
      .toBe("& 'C:\\Users\\O''Neil\\.local\\bin\\claude.exe' /login");
  });
  it("single-quotes the full path elsewhere", () => {
    expect(loginCommand("/home/o'neil/.local/bin/claude", "darwin")).toBe("'/home/o'\\''neil/.local/bin/claude' /login");
  });
});

describe("install commands", () => {
  it("uses Anthropic's official installers", () => {
    expect(installerCommand("win32")).toBe("irm https://claude.ai/install.ps1 | iex");
    expect(installerCommand("darwin")).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    expect(installerCommand("linux")).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  });

  it("on Windows installs, adds the folder to the user Path only if missing, then logs in by full path", () => {
    const cmd = installAndLoginCommand("win32");
    expect(cmd.startsWith("irm https://claude.ai/install.ps1 | iex; ")).toBe(true);
    expect(cmd).toContain("$b = \"$env:USERPROFILE\\.local\\bin\"");
    expect(cmd).toContain("-notcontains $b");
    expect(cmd).toContain("[Environment]::SetEnvironmentVariable('Path'");
    expect(cmd).toContain("'User')");
    expect(cmd.endsWith("& \"$b\\claude.exe\" /login")).toBe(true);
  });

  it("elsewhere installs, then logs in by full path only if the install succeeded", () => {
    expect(installAndLoginCommand("darwin"))
      .toBe("curl -fsSL https://claude.ai/install.sh | bash && \"$HOME/.local/bin/claude\" /login");
  });
});
