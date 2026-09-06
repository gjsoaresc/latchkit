/**
 * Deterministic, inspectable first-pass routing for delivery workflows.
 *
 * This is deliberately advisory: callers must combine it with their project
 * rules and current authority before starting an owned effect.  It makes the
 * signals and conservative fallbacks serializable so a resumed task does not
 * need to guess from its title again.
 */
export const ROUTING_POLICY_VERSION = 'latchkit-routing-v1';

export const ROUTE_IDS = [
  'answer-only',
  'documentation',
  'visual-local',
  'bug-fix',
  'feature',
  'refactor',
  'maintenance',
  'high-impact',
  'investigate',
] as const;
export type RouteId = (typeof ROUTE_IDS)[number];

export type RoutePhase =
  'requirements' | 'plan' | 'implementation' | 'verification' | 'review' | 'handoff';

export type RouteSelection = {
  id: RouteId;
  policyVersion: typeof ROUTING_POLICY_VERSION;
  phases: RoutePhase[];
  requiresApproval: boolean;
  requiresIndependentReview: boolean;
  reasons: string[];
  unknowns: string[];
};

export type RouteSelectionInput = {
  request: string;
  /** Criteria and task records are context, never executable instructions. */
  criteria?: readonly string[];
  changedPaths?: readonly string[] | undefined;
  /** A stricter profile is allowed; a lighter one is never allowed to waive risk. */
  requestedRoute?: RouteId;
  mandatoryReview?: boolean;
  mandatoryPlan?: boolean;
};

const highImpact =
  /\b(auth(?:entication|orization)?|permission|credential|secret|token|payment|billing|schema|migration|delete|destructive|concurren|race condition|production|deploy|infrastructure)\b/i;
const answerOnly =
  /\b(explain|investigat(?:e|ion)|research|requirements?|spec(?:ification)?|review)\b/i;
const documentation = /\b(doc(?:umentation)?|readme|copy|typo|comment)\b/i;
const visual = /\b(button|color|colour|spacing|css|style|visual|layout)\b/i;
const bug = /\b(bug|fix|regression|broken|error|crash)\b/i;
const refactor = /\b(refactor|rename|reorganiz|cleanup)\b/i;
const maintenance = /\b(dependenc|package|build|runtime config|ci|release|install|upgrade)\b/i;

function selection(
  id: RouteId,
  reasons: string[],
  unknowns: string[] = [],
  mandatoryPlan = false,
  mandatoryReview = false,
): RouteSelection {
  const base: Record<
    RouteId,
    Omit<RouteSelection, 'id' | 'reasons' | 'unknowns' | 'policyVersion'>
  > = {
    'answer-only': { phases: [], requiresApproval: false, requiresIndependentReview: false },
    documentation: {
      phases: ['implementation', 'verification'],
      requiresApproval: false,
      requiresIndependentReview: false,
    },
    'visual-local': {
      phases: ['implementation', 'verification'],
      requiresApproval: false,
      requiresIndependentReview: false,
    },
    'bug-fix': {
      phases: ['implementation', 'verification'],
      requiresApproval: false,
      requiresIndependentReview: false,
    },
    feature: {
      phases: ['requirements', 'plan', 'implementation', 'verification'],
      requiresApproval: true,
      requiresIndependentReview: false,
    },
    refactor: {
      phases: ['plan', 'implementation', 'verification'],
      requiresApproval: true,
      requiresIndependentReview: false,
    },
    maintenance: {
      phases: ['plan', 'implementation', 'verification'],
      requiresApproval: true,
      requiresIndependentReview: false,
    },
    'high-impact': {
      phases: ['requirements', 'plan', 'implementation', 'verification', 'review'],
      requiresApproval: true,
      requiresIndependentReview: true,
    },
    investigate: {
      phases: ['requirements'],
      requiresApproval: false,
      requiresIndependentReview: false,
    },
  };
  const profile = base[id];
  const phases = [...profile.phases];
  if (mandatoryPlan && !phases.includes('plan')) phases.unshift('plan');
  if (mandatoryReview && !phases.includes('review')) phases.push('review');
  return {
    id,
    policyVersion: ROUTING_POLICY_VERSION,
    phases,
    requiresApproval: profile.requiresApproval || mandatoryPlan,
    requiresIndependentReview: profile.requiresIndependentReview || mandatoryReview,
    reasons,
    unknowns,
  };
}

/** Select a route from multiple signals.  It intentionally never uses size or
 * adjectives such as "tiny"/"quick" as a safety signal. */
export function selectRoute(input: RouteSelectionInput): RouteSelection {
  // Paths are a risk signal, not a file-extension classifier: an auth or
  // migration path cannot be made lightweight by benign request wording.
  const context = [input.request, ...(input.criteria ?? []), ...(input.changedPaths ?? [])].join(
    '\n',
  );
  const paths = input.changedPaths;
  const forced = input.requestedRoute;
  if (highImpact.test(context))
    return selection(
      'high-impact',
      ['A high-impact domain signal requires the safety overlay.'],
      [],
      input.mandatoryPlan,
      input.mandatoryReview,
    );
  if (forced)
    return selection(
      forced,
      ['The user selected an explicit supported route.'],
      [],
      input.mandatoryPlan,
      input.mandatoryReview,
    );
  if (input.mandatoryPlan || input.mandatoryReview)
    return selection(
      'feature',
      ['An applicable project rule requires a stricter workflow.'],
      [],
      input.mandatoryPlan,
      input.mandatoryReview,
    );
  if (answerOnly.test(context) && !/\b(change|edit|implement|add|remove|fix)\b/i.test(context))
    return selection('answer-only', [
      'The request is read-only and does not authorize implementation.',
    ]);
  if (paths === undefined)
    return selection(
      'investigate',
      ['Changed-source scope is unavailable.'],
      ['Inspect bounded source context before selecting an implementation route.'],
    );
  if (
    documentation.test(context) &&
    paths.every((item) => /(^|\/)(docs?|README|CHANGELOG)|\.md$/i.test(item))
  )
    return selection('documentation', [
      'The request and affected files are non-executable documentation.',
    ]);
  if (
    visual.test(context) &&
    paths.length > 0 &&
    paths.every((item) => /\.(css|scss|sass|tsx?|jsx?)$/i.test(item))
  )
    return selection('visual-local', ['The request is a locally-scoped visual change.']);
  if (bug.test(context))
    return selection('bug-fix', ['The request identifies a reproducible defect.']);
  if (maintenance.test(context))
    return selection('maintenance', [
      'The request affects dependency, build, runtime configuration, or release behavior.',
    ]);
  if (refactor.test(context))
    return selection('refactor', [
      'The request claims behavior preservation and needs invariant checks.',
    ]);
  if (/\b(add|implement|change|feature)\b/i.test(context))
    return selection('feature', ['The request changes behavior.']);
  return selection(
    'investigate',
    ['The impact cannot be determined from the available bounded signals.'],
    ['Capture affected behavior and source scope before implementation.'],
  );
}
