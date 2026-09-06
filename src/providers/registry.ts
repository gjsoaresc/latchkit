import { PROVIDER_CONTRACT_VERSION, validateProviderContract } from './contracts.js';
import { CURSOR_CLI_PROVIDER } from './cursor-cli.js';
import { CLAUDE_CONTRACT } from './claude.js';
import { CURSOR_IDE_CONTRACT } from './cursor-ide.js';
import { ANTIGRAVITY_ADAPTER } from './antigravity.js';
import { CODEX_CONTRACT } from './codex.js';

const unknown = (reason: string) => ({
  state: 'unknown',
  reason,
  versionRange: '*',
  evidenceUrl: '',
});
const supported = (evidenceUrl: string) => ({
  state: 'supported',
  reason: 'Supported for portable skill export.',
  versionRange: '*',
  evidenceUrl,
});
const baseCapabilities = (skillEvidence: string) => ({
  skills: supported(skillEvidence),
  invocation: unknown('Invocation has no provider adapter evidence.'),
  hooks: {},
  decisions: {
    blocking: unknown('No provider hook adapter is installed.'),
    advisory: unknown('No provider hook adapter is installed.'),
  },
  compaction: unknown('Compaction has no provider adapter evidence.'),
  resume: unknown('Resume has no provider adapter evidence.'),
  cancellation: unknown('Cancellation has no provider adapter evidence.'),
  usage: unknown('Usage reporting has no provider adapter evidence.'),
});

const definitions: ReadonlyArray<
  readonly [id: string, label: string, command: string, skillDirectory: string, evidenceUrl: string]
> = [
  ['claude', 'Claude Code', 'claude', '.claude/skills', 'https://code.claude.com/docs/en/skills'],
  ['codex', 'Codex', 'codex', '.agents/skills', 'https://learn.chatgpt.com/docs/build-skills'],
  [
    'antigravity',
    'Antigravity CLI',
    'agy',
    '.agents/skills',
    'https://antigravity.google/docs/cli/overview',
  ],
  ['cursor', 'Cursor IDE', 'cursor', '.agents/skills', 'https://cursor.com/docs/skills'],
  [
    'cursor-cli',
    'Cursor CLI',
    'cursor-agent',
    '.agents/skills',
    'https://cursor.com/docs/cli/using',
  ],
];

export const PROVIDERS = Object.freeze(
  definitions.map(([id, label, command, skillDirectory, evidenceUrl]) => {
    if (id === 'claude') return CLAUDE_CONTRACT;
    if (id === 'codex') return CODEX_CONTRACT;
    if (id === 'cursor') return CURSOR_IDE_CONTRACT;
    if (id === 'cursor-cli') return validateProviderContract(CURSOR_CLI_PROVIDER);
    if (id === 'antigravity') return ANTIGRAVITY_ADAPTER.contract;
    return validateProviderContract({
      schemaVersion: PROVIDER_CONTRACT_VERSION,
      id,
      label,
      command,
      skillDirectory,
      capabilities: baseCapabilities(evidenceUrl),
      verification: {
        installed: 'unknown',
        authenticated: 'unknown',
        configured: 'unverified',
        endToEnd: 'unverified',
      },
    });
  }),
);

export function providerById(id: string) {
  return PROVIDERS.find((provider) => provider.id === id) ?? null;
}
