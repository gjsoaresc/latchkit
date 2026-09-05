export const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', command: 'claude', skillDirectory: '.claude/skills' },
  { id: 'codex', label: 'Codex', command: 'codex', skillDirectory: '.agents/skills' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', skillDirectory: '.agents/skills' },
  { id: 'cursor', label: 'Cursor IDE', command: 'cursor', skillDirectory: '.agents/skills' },
  { id: 'cursor-cli', label: 'Cursor CLI', command: 'agent', skillDirectory: '.agents/skills' },
];

export const SKILLS = [
  { id: 'spec', label: 'Spec & build', description: 'Turn requirements into a scoped plan, implementation, and verification evidence.' },
  { id: 'fix', label: 'Reproduce & fix', description: 'Reproduce a defect, repair its cause, and check for regressions.' },
  { id: 'review', label: 'Review changes', description: 'Inspect a diff for actionable defects and missing verification.' },
  { id: 'handoff', label: 'Save a handoff', description: 'Capture decisions, evidence, and next steps for another session.' },
];
