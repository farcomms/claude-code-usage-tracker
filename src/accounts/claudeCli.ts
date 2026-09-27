import * as path from "node:path";

// Anthropic's official Claude Code installers and setup guide
// (https://code.claude.com/docs/en/setup). The native installer puts the
// binary in ~/.local/bin (%USERPROFILE%\.local\bin\claude.exe on Windows)
// and doesn't always add that folder to PATH.
export const INSTALL_GUIDE_URL = "https://code.claude.com/docs/en/setup";
const INSTALL_PS1 = "irm https://claude.ai/install.ps1 | iex";
const INSTALL_SH = "curl -fsSL https://claude.ai/install.sh | bash";

export interface CliDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: () => string;
  exists: (path: string) => boolean;
}

/**
 * Full path of the `claude` CLI: first on PATH, then the native installer's
 * folder (and, off Windows, the older ~/.claude/local install); null if not installed.
 */
export function findClaude(d: CliDeps): string | null {
  const win = d.platform === "win32";
  const p = win ? path.win32 : path.posix;
  const names = win ? ["claude.exe", "claude.cmd"] : ["claude"];
  const dirs = (d.env.PATH ?? d.env.Path ?? "").split(win ? ";" : ":")
    .map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  dirs.push(p.join(d.homedir(), ".local", "bin"));
  if (!win) { dirs.push(p.join(d.homedir(), ".claude", "local")); }
  for (const dir of dirs) {
    for (const name of names) {
      const full = p.join(dir, name);
      if (d.exists(full)) { return full; }
    }
  }
  return null;
}

/** How to open a terminal: the program to run, its arguments, and text to type into it. */
export interface TerminalSpec { shellPath: string; shellArgs?: string[]; text?: string }

/**
 * Run `claude /login` by full path, so it works even when claude isn't on PATH.
 * Off Windows, claude itself is the terminal's program, so the user's default
 * shell (bash, zsh, fish, pwsh…) doesn't matter and nothing needs quoting.
 */
export function loginTerminal(claudePath: string, platform: NodeJS.Platform): TerminalSpec {
  return platform === "win32"
    ? { shellPath: "powershell.exe", text: `& '${claudePath.replace(/'/g, "''")}' /login` }
    : { shellPath: claudePath, shellArgs: ["/login"] };
}

export function installerCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? INSTALL_PS1 : INSTALL_SH;
}

/**
 * Install Claude Code, then log in by full path — only if the install produced
 * the binary. On Windows (PowerShell) it also adds the install folder to the
 * user Path when missing, editing the registry value directly so entries like
 * %USERPROFILE%\... keep their variables, then broadcasting the change.
 * Elsewhere it runs in bash (the installer needs it); the installer prints its
 * own PATH advice and shell startup files are left alone.
 */
export function installTerminal(platform: NodeJS.Platform): TerminalSpec {
  if (platform !== "win32") {
    const bin = `"$HOME/.local/bin/claude"`;
    return { shellPath: "/bin/bash", text: `${INSTALL_SH} && [ -x ${bin} ] && ${bin} /login` };
  }
  const addToUserPath =
    `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); ` +
    `$p = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); ` +
    `$have = @($p -split ';' | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"')).TrimEnd('\\') }); ` +
    `if ($have -notcontains $b) { ` +
      `$k.SetValue('Path', ((@($p.TrimEnd(';'), $b) | Where-Object { $_ }) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString); ` +
      `[Environment]::SetEnvironmentVariable('CLAUDE_USAGE_PATH_REFRESH', $null, 'User') ` + // broadcasts the change
    `}; ` +
    `$k.Close()`;
  const text =
    `${INSTALL_PS1}; ` +
    `$b = "$env:USERPROFILE\\.local\\bin"; ` +
    `if (Test-Path "$b\\claude.exe") { ${addToUserPath}; & "$b\\claude.exe" /login } ` +
    `else { Write-Host "Claude Code didn't install. See the messages above, or follow ${INSTALL_GUIDE_URL}" }`;
  return { shellPath: "powershell.exe", text };
}

// Production deps factory (used by extension.ts).
export function defaultCliDeps(): CliDeps {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  return {
    platform: process.platform,
    env: process.env,
    homedir: () => os.homedir(),
    exists: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
  };
}
