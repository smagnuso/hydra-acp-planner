// Windows-only shimming for spawning the `hydra-acp` binary.
//
// spawnSync() does not apply PATHEXT: spawnSync("hydra-acp", [...]) looks
// for a file literally named `hydra-acp`, which npm never installs on
// Windows. The shim on PATH is `hydra-acp.cmd`. A `.cmd` file also isn't
// a PE image, so CreateProcess can't launch it directly; it has to go
// through cmd.exe, which is what `shell: true` does. Mirrors cli's own
// windows-command.ts, trimmed to the one binary this package ever spawns
// (no cross-package dependency exists between planner and cli today).
// Everything here is a no-op on non-Windows.

import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";

const WINDOWS_EXTS = [".cmd", ".bat", ".exe", ".com"];

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveHydraAcpBin(): string {
  const pathVar = process.env.PATH ?? process.env.Path ?? "";
  for (const dir of pathVar.split(delimiter).filter((d) => d.length > 0)) {
    for (const ext of WINDOWS_EXTS) {
      for (const variant of [ext, ext.toUpperCase()]) {
        const candidate = join(dir, `hydra-acp${variant}`);
        if (isFile(candidate)) return candidate;
      }
    }
  }
  return "hydra-acp";
}

// cmd.exe re-interprets these even inside double quotes. None of
// hydra-acp's own arguments (session ids, "--force", "--json") ever
// contain them; this is whitespace-safety, not an escape hatch for
// arbitrary input.
function quoteForCmd(token: string): string {
  return /[\s&|<>^()"]/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token;
}

export function spawnHydraAcp(
  args: string[],
  opts: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function spawnHydraAcp(args: string[], opts: SpawnSyncOptions): SpawnSyncReturns<Buffer>;
export function spawnHydraAcp(
  args: string[],
  opts: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer> {
  if (process.platform !== "win32") {
    return spawnSync("hydra-acp", args, opts as SpawnSyncOptionsWithStringEncoding);
  }
  const bin = resolveHydraAcpBin();
  const useShell = /\.(cmd|bat)$/i.test(bin);
  if (!useShell) {
    return spawnSync(bin, args, opts as SpawnSyncOptionsWithStringEncoding);
  }
  return spawnSync(quoteForCmd(bin), args.map(quoteForCmd), {
    ...opts,
    shell: true,
  } as SpawnSyncOptionsWithStringEncoding);
}
