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

/** Full path of the `claude` CLI: first on PATH, then in the native installer's folder; null if not installed. */
export function findClaude(d: CliDeps): string | null {
  const win = d.platform === "win32";
  const p = win ? path.win32 : path.posix;
  const names = win ? ["claude.exe", "claude.cmd"] : ["claude"];
  const dirs = (d.env.PATH ?? d.env.Path ?? "").split(win ? ";" : ":").filter(Boolean);
  dirs.push(p.join(d.homedir(), ".local", "bin"));
  for (const dir of dirs) {
    for (const name of names) {
      const full = p.join(dir, name);
      if (d.exists(full)) { return full; }
    }
  }
  return null;
}

/** Run `claude /login` by full path, so it works even when claude isn't on PATH. Windows runs in PowerShell. */
export function loginCommand(claudePath: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `& '${claudePath.replace(/'/g, "''")}' /login`
    : `'${claudePath.replace(/'/g, "'\\''")}' /login`;
}

export function installerCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? INSTALL_PS1 : INSTALL_SH;
}

/**
 * Install Claude Code, then log in by full path. On Windows (PowerShell) it
 * also adds the install folder to the user Path when missing, so `claude`
 * works in future terminals. Elsewhere the installer prints its own PATH
 * advice; shell startup files are left alone.
 */
export function installAndLoginCommand(platform: NodeJS.Platform): string {
  if (platform !== "win32") { return `${INSTALL_SH} && "$HOME/.local/bin/claude" /login`; }
  return [
    INSTALL_PS1,
    `$b = "$env:USERPROFILE\\.local\\bin"`,
    `$p = [Environment]::GetEnvironmentVariable('Path', 'User')`,
    `if ((@($p -split ';') -notcontains $b)) { [Environment]::SetEnvironmentVariable('Path', ((@($p, $b) | Where-Object { $_ }) -join ';'), 'User') }`,
    `& "$b\\claude.exe" /login`,
  ].join("; ");
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
