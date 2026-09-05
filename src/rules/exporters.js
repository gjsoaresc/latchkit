import { renderClaudeRule, renderCursorRule, renderScopeInstructions } from './render.js';

const slug = (scopePath) =>
  scopePath
    .normalize('NFC')
    .replaceAll('/', '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'root';

const scopedPath = (scopePath, filename) => (scopePath ? `${scopePath}/${filename}` : filename);

export function planProviderExports(model, providerIds) {
  const providers = new Set(providerIds);
  const desiredFiles = new Map();
  const desiredSections = new Map();
  const warnings = [];
  const portableFileKeys = new Map();
  const putFile = (relative, content, scopePath) => {
    const key = relative.normalize('NFC').toLowerCase();
    if (portableFileKeys.has(key))
      throw new Error(
        `Rule export collision at ${relative} for scopes ${portableFileKeys.get(key) || '.'} and ${scopePath || '.'}.`,
      );
    portableFileKeys.set(key, scopePath);
    desiredFiles.set(relative, content);
  };
  const hasCodex = providers.has('codex');
  const hasClaude = providers.has('claude');
  const hasCursor = providers.has('cursor') || providers.has('cursor-cli');

  for (const scope of model.scopes) {
    const rendered = renderScopeInstructions(scope);
    const scopeSlug = slug(scope.path);
    const agentsPath = scopedPath(scope.path, 'AGENTS.md');
    if (hasCodex) desiredSections.set(agentsPath, rendered);
    const overridePath = scopedPath(scope.path, 'AGENTS.override.md');
    if (hasCodex && (scope.existingInstructions ?? []).includes(overridePath))
      warnings.push({
        code: 'CODEX_OVERRIDE_SHADOWS_EXPORT',
        providers: ['codex'],
        scope: scope.path,
        reason: `${overridePath} takes precedence over ${agentsPath}; review the existing override or the generated AGENTS.md will not load in that scope.`,
      });

    if (hasClaude) {
      if (hasCodex) {
        desiredSections.set(scopedPath(scope.path, 'CLAUDE.md'), `@AGENTS.md\n`);
      } else {
        putFile(
          `.claude/rules/latchkit-${scopeSlug}.md`,
          renderClaudeRule(scope, rendered),
          scope.path,
        );
      }
    }

    if (hasCursor && !hasCodex)
      putFile(
        `.cursor/rules/latchkit-${scopeSlug}.mdc`,
        renderCursorRule(scope, rendered),
        scope.path,
      );
  }

  if (hasCursor && hasCodex)
    warnings.push({
      code: 'SHARED_AGENTS_VISIBILITY',
      providers: providerIds.filter((id) => ['codex', 'cursor', 'cursor-cli'].includes(id)),
      reason:
        'Cursor can discover the Codex AGENTS.md hierarchy, so Latchkit emits no duplicate .mdc copy; provider selection does not isolate visibility.',
    });
  if (hasClaude && hasCodex)
    warnings.push({
      code: 'CLAUDE_AGENTS_IMPORT',
      providers: ['claude', 'codex'],
      reason: 'Claude imports the shared AGENTS.md content explicitly at each selected scope.',
    });
  return { desiredFiles, desiredSections, warnings };
}
