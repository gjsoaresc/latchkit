import { useEffect, useSyncExternalStore } from 'react';
import { ArrowUpRight, Save } from 'lucide-react';
import { createConsoleStore } from './console-store.js';
import { FccConsole } from './fcc.js';
import { OnboardingConsole } from './onboarding.js';
import type { ConsoleState, WorkspacePreference } from './types.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Input, Label, NativeSelect } from './components/ui/fields.js';
import { Shell, Topbar } from './shell.js';

const store = createConsoleStore();

const TAGLINE = (
  <>
    Configure once.
    <br />
    Sync with confidence.
  </>
);

function providerSymbol(id: string) {
  return { claude: 'C', codex: '⌘', antigravity: 'A', cursor: '↗' }[id] ?? '•';
}

function ProviderGrid({ state }: { state: ConsoleState }) {
  const snapshot = store.getSnapshot();
  return (
    <fieldset className="selection-group" disabled={snapshot.busy}>
      <legend className="sr-only">Providers that receive workflow skills</legend>
      <div className="provider-grid">
        {state.providers.map((provider) => {
          const selected = snapshot.selection.providers.includes(provider.id);
          const detected = state.doctor.providers.find((item) => item.id === provider.id)?.detected;
          return (
            <label key={provider.id} className={`provider-card ${selected ? 'selected' : ''}`}>
              <div className="provider-top">
                <span className="provider-symbol" aria-hidden="true">
                  {providerSymbol(provider.id)}
                </span>
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(event) => store.select('providers', provider.id, event.target.checked)}
                  aria-label={provider.label}
                />
              </div>
              <span className="provider-name">{provider.label}</span>
              <span className={`detection ${detected ? 'detected' : ''}`}>
                {detected ? 'Detected' : 'Not detected'}
              </span>
              <code className="skill-directory">{provider.skillDirectory}</code>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function SkillGrid({ state }: { state: ConsoleState }) {
  const snapshot = store.getSnapshot();
  return (
    <fieldset className="selection-group" disabled={snapshot.busy}>
      <legend className="sr-only">Workflow skills to install</legend>
      <div className="skills-grid">
        {state.skills.map((skill) => {
          const selected = snapshot.selection.skills.includes(skill.id);
          return (
            <label key={skill.id} className={`skill-card ${selected ? 'selected' : ''}`}>
              <input
                type="checkbox"
                checked={selected}
                onChange={(event) => store.select('skills', skill.id, event.target.checked)}
                aria-label={`${skill.label}: ${skill.description}`}
              />
              <strong className="skill-name">{skill.label}</strong>
              <span className="skill-description">{skill.description}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const DEFAULT_WORKSPACE: WorkspacePreference = {
  executionPreference: 'direct',
  worktreeRoot: '.latchkit/worktrees',
};
const EXECUTION_PREFERENCES: {
  value: WorkspacePreference['executionPreference'];
  label: string;
  description: string;
}[] = [
  {
    value: 'ask',
    label: 'Ask every time',
    description: 'Present the worktree/direct choice before each new task starts.',
  },
  {
    value: 'always-worktree',
    label: 'Always use a worktree',
    description: 'Isolate every new task without asking again.',
  },
  {
    value: 'direct',
    label: 'Work directly in the project',
    description: 'Never create a worktree for a new task.',
  },
];

function WorkspacePreferenceCard() {
  const snapshot = store.getSnapshot();
  const workspace = { ...DEFAULT_WORKSPACE, ...snapshot.selection.workspace };
  return (
    <Card className="workspace-preference-card">
      <span className="mini-label">TASK WORKSPACE</span>
      <p className="section-note">
        Applies to new tasks only. Starting a task remains CLI/API-only; changing this default never
        moves an active or resumed task's workspace, and never weakens provider permissions.
      </p>
      <fieldset className="selection-group" disabled={snapshot.busy}>
        <legend className="sr-only">Task execution preference</legend>
        <Label>
          Execution preference
          <NativeSelect
            value={workspace.executionPreference}
            onChange={(event) =>
              store.setWorkspace({
                executionPreference: event.target
                  .value as WorkspacePreference['executionPreference'],
              })
            }
          >
            {EXECUTION_PREFERENCES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </Label>
        <p className="section-note">
          {
            EXECUTION_PREFERENCES.find((option) => option.value === workspace.executionPreference)
              ?.description
          }
        </p>
        <Label>
          Worktree root
          <Input
            type="text"
            value={workspace.worktreeRoot}
            onChange={(event) => store.setWorkspace({ worktreeRoot: event.target.value })}
          />
        </Label>
        <p className="section-note">
          Project-relative with forward slashes, or an absolute path. Defaults to a Git-ignored
          folder inside the project; it cannot be the project checkout or its Git directory.
        </p>
      </fieldset>
    </Card>
  );
}

function PlanPanel() {
  const snapshot = store.getSnapshot();
  const plan = snapshot.plan;
  if (!plan) return null;
  const blocked = plan.conflicts.length > 0 || snapshot.busy || store.dirty();
  return (
    <div className="plan-panel" aria-live="polite">
      <div className="plan-heading">
        <h3>File changes</h3>
        <span className="mini-label">{plan.changes.length} CHANGES</span>
      </div>
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
        <p>Only Latchkit-managed files are updated.</p>
        <Button onClick={() => void store.apply()} disabled={blocked}>
          Apply sync <span aria-hidden="true">→</span>
        </Button>
      </div>
    </div>
  );
}

export function SettingsConsole() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const state = snapshot.state;
  useEffect(() => {
    void store.initialize();
    const timer = window.setInterval(() => store.poll(), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!state)
    // A tailored placeholder (not the generic ShellPlaceholder) so the page's own structure —
    // including #providers-heading and the disabled sync controls — is present even before the
    // session connects. Real browser/acceptance checks that assert on this page load fast enough
    // to observe it before data arrives, and a disconnected session still shows the page's shape.
    return (
      <Shell active="settings" tagline={TAGLINE}>
        <Topbar breadcrumb="WORKSPACE" label="Settings" />
        <section className="intro intro-compact">
          <div>
            <p className="eyebrow">SETTINGS &amp; INTEGRATIONS</p>
            <h1>Configuration, agents, and tools.</h1>
          </div>
        </section>
        {snapshot.notice?.message && (
          <div className="notice notice-error" role="alert" tabIndex={-1}>
            {snapshot.notice.message}
          </div>
        )}
        <section id="configuration" className="config-section" aria-labelledby="providers-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">01 / YOUR TOOLBOX</p>
              <h2 id="providers-heading">Meet your agents.</h2>
              <p role="status">Connecting to local configuration…</p>
            </div>
          </div>
        </section>
        <section className="sync-section" aria-labelledby="sync-heading">
          <div className="section-heading">
            <div>
              <h2 id="sync-heading">Everything in its place.</h2>
            </div>
          </div>
          <div className="sync-toolbar">
            <p>Loading configuration…</p>
            <div className="button-row">
              <Button variant="outline" disabled>
                Save configuration
              </Button>
              <Button disabled>Preview sync</Button>
            </div>
          </div>
        </section>
      </Shell>
    );
  return (
    <Shell active="settings" tagline={TAGLINE}>
      <Topbar breadcrumb="WORKSPACE" label="Settings" />
      <section className="intro intro-compact">
        <div>
          <p className="eyebrow">SETTINGS &amp; INTEGRATIONS</p>
          <h1>Configuration, agents, and tools.</h1>
          <p className="intro-copy">
            Choose your tools, connect your skills, set task defaults, manage the optional local FCC
            tool, and finish onboarding — all from one place.
          </p>
        </div>
      </section>
      {snapshot.notice && (
        <div
          className={`notice ${snapshot.notice.error ? 'notice-error' : ''}`}
          role={snapshot.notice.error ? 'alert' : 'status'}
          aria-live="polite"
          tabIndex={-1}
        >
          {snapshot.notice.message}
        </div>
      )}
      <section id="configuration" className="config-section" aria-labelledby="providers-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">01 / YOUR TOOLBOX</p>
            <h2 id="providers-heading">Meet your agents.</h2>
            <p>Select the tools that should receive your workflow skills.</p>
          </div>
          <span className="subtle-tag">PROVIDER ADAPTERS</span>
        </div>
        <ProviderGrid state={state} />
        <p className="section-note">
          Detection checks the current environment. Native Windows and WSL have separate tool
          installations.
        </p>
      </section>
      <section className="config-section skills-section" aria-labelledby="skills-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">02 / YOUR PLAYBOOK</p>
            <h2 id="skills-heading">A workflow that follows you.</h2>
            <p>Portable instructions for the work you do every day.</p>
          </div>
          <span className="subtle-tag">SKILL.MD</span>
        </div>
        <SkillGrid state={state} />
        <p className="section-note">
          Skills guide the agent. They do not enforce hooks, permissions, or automatic quality
          gates.
        </p>
      </section>
      <section className="config-section" aria-labelledby="workspace-preference-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">03 / TASK EXECUTION</p>
            <h2 id="workspace-preference-heading">Choose how new tasks run.</h2>
            <p>Ask each time, always isolate in a worktree, or always work directly.</p>
          </div>
        </div>
        <WorkspacePreferenceCard />
      </section>
      <section className="sync-section" aria-labelledby="sync-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">04 / MAKE IT YOURS</p>
            <h2 id="sync-heading">Everything in its place.</h2>
            <p>Save your selection, review the file changes, then sync.</p>
          </div>
        </div>
        <div className="sync-toolbar">
          <p id="selection-status">
            {snapshot.busy
              ? 'Updating configuration…'
              : store.dirty()
                ? 'Selection changed. Save before previewing.'
                : 'Configuration saved. Preview changes before applying.'}
          </p>
          <div className="button-row">
            <Button
              variant="outline"
              onClick={() => void store.save()}
              disabled={snapshot.busy || !store.dirty()}
            >
              <Save aria-hidden="true" />
              Save configuration
            </Button>
            <Button onClick={() => void store.preview()} disabled={snapshot.busy || store.dirty()}>
              Preview sync <ArrowUpRight aria-hidden="true" />
            </Button>
          </div>
        </div>
        <PlanPanel />
      </section>
      <section className="config-section" aria-labelledby="mcp-settings-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">OPTIONAL MCP</p>
            <h2 id="mcp-settings-heading">Managed MCP configuration.</h2>
            <p>
              Review inert definitions, then explicitly enable only the exact configuration you
              approved.
            </p>
          </div>
          <a className="button button-outline" href="/mcp">
            Open MCP controls
          </a>
        </div>
      </section>
      <FccConsole />
      <OnboardingConsole />
    </Shell>
  );
}
