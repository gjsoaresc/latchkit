import { PROVIDER_CONTRACT_VERSION, validateProviderContract } from './contracts.js';
import { CURSOR_CLI_PROVIDER } from './cursor-cli.js';

const unknown = (reason) => ({ state: 'unknown', reason, versionRange: '*', evidenceUrl: '' });
const supported = (evidenceUrl) => ({
  state: 'supported',
  reason: 'Supported for portable skill export.',
  versionRange: '*',
  evidenceUrl,
});
const baseCapabilities = (skillEvidence) => ({
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

const definitions = [
  ['claude', 'Claude Code', 'claude', '.claude/skills', 'https://code.claude.com/docs/en/skills'],
  ['codex', 'Codex', 'codex', '.agents/skills', 'https://learn.chatgpt.com/docs/build-skills'],
  [
    'gemini',
    'Gemini CLI',
    'gemini',
    '.agents/skills',
    'https://geminicli.com/docs/cli/using-agent-skills/',
  ],
  ['cursor', 'Cursor IDE', 'cursor', '.agents/skills', 'https://cursor.com/docs/skills'],
  ['cursor-cli', 'Cursor CLI', 'agent', '.agents/skills', 'https://cursor.com/docs/cli/using'],
];

export const PROVIDERS = Object.freeze(
  definitions.map(([id, label, command, skillDirectory, evidenceUrl]) => {
    if (id === 'cursor-cli') return validateProviderContract(CURSOR_CLI_PROVIDER);
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

export function providerById(id) {
  return PROVIDERS.find((provider) => provider.id === id) ?? null;
}
