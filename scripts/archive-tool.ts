import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const command = promisify(execFile);
type TarTool = { tool: string; prefixArgs: string[] };

let resolved: TarTool | undefined;

/**
 * Resolve a `tar` invocation that accepts absolute archive paths on every supported platform.
 *
 * On Windows, GNU tar (for example Git for Windows' `usr/bin/tar.exe`) treats the drive letter in
 * `C:\...` as a legacy remote `host:file` spec and fails with "Cannot connect to C:". The bsdtar
 * shipped in `%SystemRoot%\System32` handles drive letters natively (and is what CI resolves), so
 * it is preferred when present. When only a GNU tar is available, its documented `--force-local`
 * escape hatch is added; bsdtar rejects that flag, so it is never passed blindly.
 *
 * @returns {Promise<{ tool: string, prefixArgs: string[] }>}
 */
export async function resolveTar() {
  if (resolved) return resolved;
  if (process.platform !== 'win32') {
    resolved = { tool: 'tar', prefixArgs: [] };
    return resolved;
  }
  const system32 = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe');
  if (existsSync(system32)) {
    resolved = { tool: system32, prefixArgs: [] };
    return resolved;
  }
  const gnu = await isGnuTar('tar');
  resolved = { tool: 'tar', prefixArgs: gnu ? ['--force-local'] : [] };
  return resolved;
}

async function isGnuTar(tool: string): Promise<boolean> {
  try {
    const { stdout } = await command(tool, ['--version'], { windowsHide: true, timeout: 10_000 });
    return /GNU tar/i.test(stdout);
  } catch {
    return false;
  }
}

/** Run `tar` with the resolved tool and platform prefix arguments. */
export async function tar(args: string[], options: Parameters<typeof command>[2] = {}) {
  const { tool, prefixArgs } = await resolveTar();
  return command(tool, [...prefixArgs, ...args], { windowsHide: true, ...options });
}
