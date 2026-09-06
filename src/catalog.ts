// Compatibility re-export; provider definitions live in providers/registry.js.
export { PROVIDERS } from './providers/registry.js';

export const SKILLS = [
  {
    id: 'requirements',
    label: 'Discover requirements',
    description: 'Clarify audience, scope, decisions, and observable acceptance criteria.',
  },
  {
    id: 'spec',
    label: 'Write a specification',
    description: 'Turn accepted requirements into a scoped, reviewable delivery plan.',
  },
  {
    id: 'build',
    label: 'Build with evidence',
    description: 'Implement authorized work in bounded iterations against named criteria.',
  },
  {
    id: 'fix',
    label: 'Reproduce & fix',
    description: 'Reproduce a defect, repair its cause, and check for regressions.',
  },
  {
    id: 'review',
    label: 'Review changes',
    description: 'Inspect a diff for actionable defects and missing verification.',
  },
  {
    id: 'handoff',
    label: 'Save a handoff',
    description: 'Capture decisions, evidence, and next steps for another session.',
  },
  {
    id: 'setup',
    label: 'Set up guidance',
    description:
      'Prepare scoped provider guidance while previewing conflicts and preserving user files.',
  },
];
