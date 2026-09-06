import path from 'node:path';
import { VERSION } from '../version.js';

const handlers = {
  claude: 'claude-hook.js',
  codex: 'codex-handler.js',
  cursor: 'cursor-ide-hook.cjs',
} as const;

/** Bind exported hooks to the immutable installation that produced them. */
export function standaloneHookCommand(
  handler: keyof typeof handlers,
  arguments_: string[] = [],
  options: { scriptPath?: string; nodeExecutable?: string; platform?: NodeJS.Platform } = {},
): string | null {
  const root = process.env.LATCHKIT_INSTALL_ROOT;
  const platform = options.platform ?? process.platform;
  if (!root || !path.isAbsolute(root) || platform !== process.platform) return null;
  const key = `${VERSION}-${process.platform}-${process.arch}`;
  const versionRoot = path.join(root, 'versions', key);
  const node = path.join(versionRoot, 'runtime', platform === 'win32' ? 'node.exe' : 'node');
  if (path.resolve(options.nodeExecutable ?? process.execPath) !== path.resolve(node)) return null;
  if (
    options.scriptPath &&
    path.resolve(options.scriptPath) !==
      path.join(versionRoot, 'app/dist/src/providers', handlers[handler])
  )
    return null;
  const tokens =
    platform === 'win32'
      ? [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          path.join(root, 'bin/latchkit-hook.ps1'),
        ]
      : [path.join(root, 'bin/latchkit-hook')];
  tokens.push('--version', key, '--handler', handler, ...arguments_);
  return tokens
    .map((token) =>
      platform === 'win32'
        ? `"${token.replaceAll('"', '\\"')}"`
        : `'${token.replaceAll("'", "'\\''")}'`,
    )
    .join(' ');
}
