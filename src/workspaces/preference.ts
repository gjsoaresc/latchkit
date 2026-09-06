import type { WorkspaceExecutionPreference } from '../config/contracts.js';

/** An explicit per-task choice: whether this run isolates its implementation
 * in a Git worktree, or works directly in the project checkout. Unlike the
 * project preference, an explicit choice is never "ask" — a caller that
 * cannot yet decide simply omits it. */
export type WorkspaceExecutionChoice = 'worktree' | 'direct';

export interface ResolveExecutionChoiceInput {
  /** The project's persisted default (`workspace.executionPreference`, or the
   * documented default when the project has not set one). */
  projectPreference: WorkspaceExecutionPreference;
  /** An explicit per-task/per-call override, e.g. a resolved answer to an
   * "ask every time" prompt, or an explicit CLI/API choice. Always wins over
   * the project preference when present. */
  override?: WorkspaceExecutionChoice;
}

export type ResolveExecutionChoiceResult =
  | { decision: WorkspaceExecutionChoice; source: 'override' | 'preference' }
  /** The project preference is "ask every time" and no explicit choice was
   * given. The caller must not start anything: it must present the
   * worktree/direct choice and only proceed once it has an explicit answer. */
  | { decision: 'undecided'; reason: 'ASK_REQUIRED' };

/** Pure precedence rule for whether a new task's implementation isolates in a
 * worktree or runs directly in the project: an explicit per-task override
 * always wins; otherwise the project's persisted preference decides; "ask
 * every time" with no override resolves to `undecided`, which callers must
 * treat as "start nothing" until an explicit choice is supplied.
 *
 * This never applies to resuming an existing task or session: a resume must
 * reuse whatever workspace (or lack of one) the task already has and must
 * never call this function to re-decide, so changing the project default
 * cannot move an active task's workspace. It is also independent of any
 * reviewer isolation, which is decided separately. */
export function resolveExecutionChoice({
  projectPreference,
  override,
}: ResolveExecutionChoiceInput): ResolveExecutionChoiceResult {
  if (override === 'worktree' || override === 'direct')
    return { decision: override, source: 'override' };
  if (projectPreference === 'always-worktree')
    return { decision: 'worktree', source: 'preference' };
  if (projectPreference === 'direct') return { decision: 'direct', source: 'preference' };
  return { decision: 'undecided', reason: 'ASK_REQUIRED' };
}
