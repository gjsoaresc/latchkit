// Compatibility re-export; provider definitions live in providers/registry.js.
export { PROVIDERS } from './providers/registry.js';

export const SKILLS = [
  {
    id: 'spec',
    label: 'Spec & build',
    description: 'Turn requirements into a scoped plan, implementation, and verification evidence.',
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
];
