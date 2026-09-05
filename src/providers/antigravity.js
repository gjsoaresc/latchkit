import { createProviderAdapter, validateCommandPlan } from './contracts.js';

const DOCS_URL = 'https://github.com/google-antigravity/antigravity-cli';
const CLI_DOCS_URL = 'https://antigravity.google/docs/cli/overview';

const evidence = (state, reason, evidenceUrl = CLI_DOCS_URL) => ({
  state,
  reason,
  versionRange: '*',
  evidenceUrl,
});

const contract = {
  schemaVersion: 1,
  id: 'antigravity',
  label: 'Antigravity CLI',
  command: 'agy',
  skillDirectory: '.agents/skills',
  capabilities: {
    skills: evidence(
      'supported',
      'Antigravity CLI operates in the project workspace and can discover workspace skills.',
    ),
    invocation: evidence(
      'supported',
      'Official documentation describes print mode (-p/--print) and machine-readable JSON output.',
      DOCS_URL,
    ),
    hooks: {},
    decisions: {
      blocking: evidence('unknown', 'No stable provider hook contract is documented.'),
      advisory: evidence('unknown', 'No stable provider hook contract is documented.'),
    },
    compaction: evidence(
      'unknown',
      'Compaction events are not exposed by the documented CLI contract.',
    ),
    resume: evidence(
      'unknown',
      'Resume is documented as an interactive /resume flow, not a stable non-interactive argument.',
      CLI_DOCS_URL,
    ),
    cancellation: evidence(
      'partial',
      'The bounded host runner can cancel the process; Antigravity-native cancellation is not claimed.',
    ),
    usage: evidence('unknown', 'Usage fields are not normalized by this adapter.'),
  },
  verification: {
    installed: 'unknown',
    authenticated: 'unknown',
    configured: 'unverified',
    endToEnd: 'unverified',
  },
};

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

export function parseAntigravityVersion(output) {
  const match = typeof output === 'string' && output.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/);
  return match ? match[1] : null;
}

export function inspectAntigravity({ versionOutput = '' } = {}) {
  return { version: parseAntigravityVersion(versionOutput), contract };
}

export function planAntigravityInvocation({ prompt, cwd, outputFormat = 'json' } = {}) {
  requiredText(prompt, 'prompt');
  if (!['json', 'stream-json'].includes(outputFormat))
    throw new TypeError('Antigravity adapter requires JSON or stream-json output.');
  return validateCommandPlan({
    executable: 'agy',
    args: ['-p', prompt, '--output-format', outputFormat],
    cwd,
  });
}

export function planAntigravityResume() {
  return {
    supported: false,
    reason:
      'Antigravity documents resume through its interactive /resume picker; no stable non-interactive resume argument is documented.',
  };
}

function unsupported(name) {
  return () => ({
    supported: false,
    reason: `Antigravity does not expose a documented ${name} integration contract.`,
  });
}

export function createAntigravityAdapter() {
  return createProviderAdapter(contract, {
    inspect: () => inspectAntigravity(),
    planInstall: unsupported('project hook/settings'),
    planSkillExport: ({ skills = [] } = {}) => ({
      provider: 'antigravity',
      directory: '.agents/skills',
      skills: [...skills],
    }),
    planRuleExport: ({ rules = [] } = {}) => ({
      provider: 'antigravity',
      directory: '.agents/skills',
      rules: [...rules],
    }),
    planInvocation: planAntigravityInvocation,
    planResume: planAntigravityResume,
    translateLifecycleInput: unsupported('lifecycle events'),
    translateLifecycleOutput: unsupported('lifecycle events'),
    planUsage: () => ({
      state: 'unknown',
      reason: 'Antigravity usage fields are not normalized by this adapter.',
    }),
  });
}

export const ANTIGRAVITY_ADAPTER = createAntigravityAdapter();
