import { useEffect, useState } from 'react';
import type { inspectOnboarding } from '../src/onboarding/service.js';
import { api } from './api.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Input, Label, NativeSelect } from './components/ui/fields.js';

type OnboardingView = Awaited<ReturnType<typeof inspectOnboarding>>;
type StepId = 'project' | 'providers' | 'workspace' | 'verification' | 'usage' | 'preview';
type SyncPreview = {
  changes: { action: string; path: string }[];
  conflicts: { path: string; reason: string }[];
  planId: string;
};

const STEP_ORDER: StepId[] = [
  'project',
  'providers',
  'workspace',
  'verification',
  'usage',
  'preview',
];
const STEP_LABELS: Record<StepId, string> = {
  project: 'Project',
  providers: 'Agents & skills',
  workspace: 'Task workspace',
  verification: 'Verification',
  usage: 'Usage collection',
  preview: 'Preview & apply',
};
const EXECUTION_PREFERENCES: { value: string; label: string; description: string }[] = [
  {
    value: 'ask',
    label: 'Ask every time',
    description: 'Present the worktree/direct choice before each new task starts.',
  },
  {
    value: 'always-worktree',
    label: 'Always use a worktree',
    description: 'Isolate every new task in a Git worktree without asking again.',
  },
  {
    value: 'direct',
    label: 'Work directly in the project',
    description: 'Never create a worktree for a new task (today’s default behavior).',
  },
];

function toggled(list: string[], id: string, checked: boolean): string[] {
  return checked ? [...new Set([...list, id])] : list.filter((item) => item !== id);
}

export function OnboardingConsole() {
  const [state, setState] = useState<OnboardingView>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean }>();
  const [providersDraft, setProvidersDraft] = useState<string[]>([]);
  const [skillsDraft, setSkillsDraft] = useState<string[]>([]);
  const [executionDraft, setExecutionDraft] = useState('direct');
  const [worktreeRootDraft, setWorktreeRootDraft] = useState('.latchkit/worktrees');
  const [verificationDraft, setVerificationDraft] = useState<'fast' | 'standard'>('standard');
  const [usageDraft, setUsageDraft] = useState(false);
  const [plan, setPlan] = useState<SyncPreview>();

  async function load() {
    const data = await api<OnboardingView>('onboarding');
    setState(data);
    setProvidersDraft(data.selection.providers);
    setSkillsDraft(data.selection.skills);
    setExecutionDraft(data.workspace.executionPreference);
    setWorktreeRootDraft(data.workspace.worktreeRoot);
    setVerificationDraft(data.verification.defaultMode);
    setUsageDraft(data.usage.enabled);
  }

  useEffect(() => {
    load().catch((failure: unknown) =>
      setNotice({
        message:
          failure instanceof Error ? failure.message : 'Onboarding state could not be loaded.',
        error: true,
      }),
    );
  }, []);

  async function run(action: () => Promise<unknown>, successMessage: string) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      await load();
      setNotice({ message: successMessage, error: false });
    } catch (failure) {
      setNotice({
        message: failure instanceof Error ? failure.message : 'The action failed.',
        error: true,
      });
    } finally {
      setBusy(false);
    }
  }

  if (!state)
    return (
      <section id="onboarding" className="config-section" aria-labelledby="onboarding-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">GET STARTED</p>
            <h2 id="onboarding-heading">Finish setting up.</h2>
            <p>Loading onboarding status…</p>
          </div>
        </div>
        {notice && (
          <div className="notice notice-error" role="alert">
            {notice.message}
          </div>
        )}
      </section>
    );

  const { progress, providers, skills, readiness } = state;
  const skip = (stepId: StepId) =>
    run(
      () => api('onboarding/skip', { method: 'POST', body: { stepId } }),
      `Skipped "${STEP_LABELS[stepId]}".`,
    );
  const back = (stepId: StepId) =>
    run(
      () => api('onboarding/back', { method: 'POST', body: { stepId } }),
      `Back to a previous step.`,
    );

  return (
    <section id="onboarding" className="config-section" aria-labelledby="onboarding-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">GET STARTED</p>
          <h2 id="onboarding-heading">Finish setting up.</h2>
          <p>
            Choose your project, agents, workspace, and workflow preferences. Skip anything
            optional, or dismiss and come back later — nothing already saved is lost.
          </p>
        </div>
        <span className="subtle-tag">{progress.status.replace('-', ' ').toUpperCase()}</span>
      </div>
      {notice && (
        <div
          className={`notice ${notice.error ? 'notice-error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
          aria-live="polite"
        >
          {notice.message}
        </div>
      )}
      <ol className="onboarding-steps" aria-label="Onboarding steps">
        {STEP_ORDER.map((id) => (
          <li
            key={id}
            className={`onboarding-step${progress.currentStepId === id ? ' current' : ''}${
              progress.completedStepIds.includes(id) ? ' done' : ''
            }${progress.skippedStepIds.includes(id) ? ' skipped' : ''}`}
          >
            {STEP_LABELS[id]}
          </li>
        ))}
      </ol>

      <Card className="onboarding-card">
        <span className="mini-label">1. PROJECT</span>
        <p className="section-note">
          {state.initialized
            ? `Project is initialized at ${state.doctor.project}.`
            : `Project at ${state.doctor.project} is not initialized yet.`}
        </p>
        <p className="section-note">
          To onboard a different existing directory, run{' '}
          <code>latchkit onboarding project --project &lt;path&gt;</code> from the CLI, or restart
          the console with <code>latchkit ui --project &lt;path&gt;</code>.
        </p>
        <div className="button-row">
          <Button
            onClick={() =>
              run(
                () => api('onboarding/project', { method: 'POST', body: {} }),
                'Project confirmed.',
              )
            }
            disabled={busy}
          >
            {state.initialized ? 'Confirm project' : 'Initialize project'}
          </Button>
        </div>
      </Card>

      <Card className="onboarding-card">
        <span className="mini-label">2. AGENTS &amp; SKILLS</span>
        <p className="section-note">
          Detection checks the current environment honestly: unavailable (not found on PATH),
          installed (found, not selected), or configured (found and selected here). Authentication
          is always reported as unknown — only the provider itself can confirm a signed-in session.
        </p>
        <fieldset className="selection-group onboarding-checklist" disabled={busy}>
          <legend className="sr-only">Coding agents</legend>
          {providers.map((provider) => (
            <label key={provider.id} className="skill-card onboarding-row">
              <input
                type="checkbox"
                checked={providersDraft.includes(provider.id)}
                onChange={(event) =>
                  setProvidersDraft(toggled(providersDraft, provider.id, event.target.checked))
                }
              />
              <strong>{provider.label}</strong>
              <span className={`onboarding-status onboarding-status-${provider.status}`}>
                {provider.status}
              </span>
              <span className="skill-description">authentication: {provider.authenticated}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="selection-group onboarding-checklist" disabled={busy}>
          <legend className="sr-only">Workflow skills</legend>
          {skills.map((skill) => (
            <label key={skill.id} className="skill-card onboarding-row">
              <input
                type="checkbox"
                checked={skillsDraft.includes(skill.id)}
                onChange={(event) =>
                  setSkillsDraft(toggled(skillsDraft, skill.id, event.target.checked))
                }
              />
              <strong>{skill.label}</strong>
              <span className="skill-description">{skill.description}</span>
            </label>
          ))}
        </fieldset>
        <div className="button-row">
          <Button
            onClick={() =>
              run(
                () =>
                  api('onboarding/providers', {
                    method: 'POST',
                    body: { providers: providersDraft, skills: skillsDraft },
                  }),
                'Agents and skills saved.',
              )
            }
            disabled={busy}
          >
            Save agents &amp; skills
          </Button>
          <Button variant="outline" onClick={() => void skip('providers')} disabled={busy}>
            Skip
          </Button>
          <Button variant="ghost" onClick={() => void back('providers')} disabled={busy}>
            Back
          </Button>
        </div>
      </Card>

      <Card className="onboarding-card">
        <span className="mini-label">3. TASK WORKSPACE</span>
        <p className="section-note">
          Applies to new tasks only; changing this later never moves an active or resumed task.
        </p>
        <Label>
          Execution preference
          <NativeSelect
            value={executionDraft}
            onChange={(event) => setExecutionDraft(event.target.value)}
          >
            {EXECUTION_PREFERENCES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </Label>
        <p className="section-note">
          {EXECUTION_PREFERENCES.find((option) => option.value === executionDraft)?.description}
        </p>
        <Label>
          Worktree root
          <Input
            type="text"
            value={worktreeRootDraft}
            onChange={(event) => setWorktreeRootDraft(event.target.value)}
          />
        </Label>
        <p className="section-note">
          Project-relative (forward slashes) or absolute. Defaults to a Git-ignored folder inside
          the project; change it anytime from Settings or <code>latchkit workspace preference</code>
          .
        </p>
        <div className="button-row">
          <Button
            onClick={() =>
              run(
                () =>
                  api('onboarding/workspace', {
                    method: 'POST',
                    body: { executionPreference: executionDraft, worktreeRoot: worktreeRootDraft },
                  }),
                'Workspace preference saved.',
              )
            }
            disabled={busy}
          >
            Save workspace preference
          </Button>
          <Button variant="outline" onClick={() => void skip('workspace')} disabled={busy}>
            Skip
          </Button>
          <Button variant="ghost" onClick={() => void back('workspace')} disabled={busy}>
            Back
          </Button>
        </div>
      </Card>

      <Card className="onboarding-card">
        <span className="mini-label">4. VERIFICATION</span>
        <p className="section-note">
          Fast mode bounds and reuses verification for unchanged work; standard mode is the existing
          unbounded default.
        </p>
        <Label>
          Default mode
          <NativeSelect
            value={verificationDraft}
            onChange={(event) => setVerificationDraft(event.target.value as 'fast' | 'standard')}
          >
            <option value="standard">Standard (unbounded, current default)</option>
            <option value="fast">Fast (bounded, reuses passing evidence)</option>
          </NativeSelect>
        </Label>
        <div className="button-row">
          <Button
            onClick={() =>
              run(
                () =>
                  api('onboarding/verification', {
                    method: 'POST',
                    body: { mode: verificationDraft },
                  }),
                'Verification preference saved.',
              )
            }
            disabled={busy}
          >
            Save verification mode
          </Button>
          <Button variant="outline" onClick={() => void skip('verification')} disabled={busy}>
            Skip
          </Button>
          <Button variant="ghost" onClick={() => void back('verification')} disabled={busy}>
            Back
          </Button>
        </div>
      </Card>

      <Card className="onboarding-card">
        <span className="mini-label">5. USAGE COLLECTION</span>
        <p className="section-note">
          Optional and local-only. Declining leaves usage unknown, never shown as zero — billing
          status stays &quot;unknown&quot; until you opt in and a provider reports it.
        </p>
        <label className="skill-card onboarding-row">
          <input
            type="checkbox"
            checked={usageDraft}
            onChange={(event) => setUsageDraft(event.target.checked)}
          />
          <strong>Record local usage</strong>
          <span className="skill-description">
            Stored only in this project&apos;s <code>.latchkit/</code> directory.
          </span>
        </label>
        <div className="button-row">
          <Button
            onClick={() =>
              run(
                () => api('onboarding/usage', { method: 'POST', body: { enabled: usageDraft } }),
                usageDraft ? 'Usage collection enabled.' : 'Usage collection stays disabled.',
              )
            }
            disabled={busy}
          >
            Save usage choice
          </Button>
          <Button variant="outline" onClick={() => void skip('usage')} disabled={busy}>
            Skip
          </Button>
          <Button variant="ghost" onClick={() => void back('usage')} disabled={busy}>
            Back
          </Button>
        </div>
      </Card>

      <Card className="onboarding-card">
        <span className="mini-label">6. PREVIEW &amp; APPLY</span>
        <p className="section-note">
          Reuses the same sync preview as <code>latchkit sync --dry-run</code>: the actual
          project/configuration/provider files setup will change, before anything is written.
        </p>
        <div className="button-row">
          <Button
            onClick={() =>
              run(async () => {
                const preview = await api<SyncPreview>('onboarding/preview', { method: 'POST' });
                setPlan(preview);
              }, 'Preview ready.')
            }
            disabled={busy}
          >
            Preview changes
          </Button>
          <Button variant="outline" onClick={() => void skip('preview')} disabled={busy}>
            Skip
          </Button>
          <Button variant="ghost" onClick={() => void back('preview')} disabled={busy}>
            Back
          </Button>
        </div>
        {plan && (
          <div className="plan-panel" aria-live="polite">
            {plan.conflicts.length > 0 && (
              <div className="conflicts" role="alert">
                {plan.conflicts.map((conflict) => (
                  <p key={`${conflict.path}:${conflict.reason}`}>
                    <code>{conflict.path}</code>: {conflict.reason}
                  </p>
                ))}
              </div>
            )}
            <ul className="plan-changes" aria-label="Planned file changes">
              {plan.changes.length ? (
                plan.changes.map((change) => (
                  <li key={`${change.action}:${change.path}`} className="plan-row">
                    <span className={`change-action action-${change.action}`}>{change.action}</span>
                    <code className="change-path">{change.path}</code>
                  </li>
                ))
              ) : (
                <li className="empty-plan">No managed file changes are needed.</li>
              )}
            </ul>
            <div className="plan-footer">
              <Button
                onClick={() =>
                  run(
                    () =>
                      api('onboarding/apply', { method: 'POST', body: { planId: plan.planId } }),
                    'Setup applied.',
                  )
                }
                disabled={busy || plan.conflicts.length > 0}
              >
                Apply setup <span aria-hidden="true">→</span>
              </Button>
            </div>
          </div>
        )}
      </Card>

      <section className="summary-grid" aria-label="Onboarding readiness">
        <Card className="summary-card">
          <span className="mini-label">READINESS</span>
          <div>
            <strong className="status-word">{readiness.ready ? 'Ready' : 'Not yet'}</strong>
            <span>{readiness.nextAction}</span>
          </div>
        </Card>
      </section>
      {readiness.missingPrerequisites.length > 0 && (
        <ul aria-label="Missing prerequisites">
          {readiness.missingPrerequisites.map((item) => (
            <li key={item} className="section-note">
              {item}
            </li>
          ))}
        </ul>
      )}

      <div className="button-row">
        <Button
          onClick={() =>
            run(
              () => api('onboarding/complete', { method: 'POST' }),
              'Onboarding complete. Open the project and start a spec or a task.',
            )
          }
          disabled={busy}
        >
          Finish onboarding
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            run(
              () => api('onboarding/dismiss', { method: 'POST' }),
              'Dismissed for now. Resume anytime — nothing saved is lost.',
            )
          }
          disabled={busy}
        >
          Dismiss for now
        </Button>
      </div>
    </section>
  );
}
