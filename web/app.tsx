import { useEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, CheckCircle2, CircleDot, ExternalLink, RefreshCw, Save } from 'lucide-react';
import { createConsoleStore } from './console-store.js';
import { FccConsole } from './fcc.js';
import { exportMemory, MemoryConsole } from './memory.js';
import { ThemeToggle } from './theme.js';
import { UsageConsole } from './usage.js';
import type { ConsoleState } from './types.js';
import { AcceptanceEvidence, TaskList } from './workbench.js';
import { WorkflowConsole } from './workflows.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';

const store = createConsoleStore();

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
              <span className="skill-check" aria-hidden="true">
                {selected ? <CheckCircle2 size={16} /> : <CircleDot size={16} />}
              </span>
              <strong>{skill.label}</strong>
              <span className="skill-description">{skill.description}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function Summary({ state }: { state: ConsoleState }) {
  const snapshot = store.getSnapshot();
  const detected = state.doctor.providers.filter((item) => item.detected).length;
  const saved = !store.dirty();
  return (
    <section className="summary-grid" aria-label="Workspace summary">
      <Card className="summary-card">
        <span className="mini-label">CONNECTED TOOLS</span>
        <div>
          <strong>{detected}</strong>
          <span>detected on this machine</span>
        </div>
        <ArrowUpRight className="summary-icon" aria-hidden="true" />
      </Card>
      <Card className="summary-card">
        <span className="mini-label">YOUR WORKFLOW</span>
        <div>
          <strong>{snapshot.selection.skills.length}</strong>
          <span>skills selected</span>
        </div>
        <span className="summary-icon" aria-hidden="true">
          ✳
        </span>
      </Card>
      <Card className="summary-card">
        <span className="mini-label">SYNC STATUS</span>
        <div>
          <strong className="status-word">{saved ? 'Ready' : 'Edited'}</strong>
          <span>{saved ? 'Preview before applying' : 'Save your selection'}</span>
        </div>
        <RefreshCw className="summary-icon" aria-hidden="true" />
      </Card>
    </section>
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

function ConsolePlaceholder({ message }: { message?: string }) {
  return (
    <div className="shell">
      <main id="workspace">
        <header className="topbar">
          <span className="breadcrumb">WORKSPACE</span>
        </header>
        <section className="intro">
          <div>
            <p className="eyebrow">LESS SETUP. MORE SHIPPING.</p>
            <h1>
              Your agents,
              <br />
              <span>in sync.</span>
            </h1>
          </div>
        </section>
        {message && (
          <div className="notice notice-error" role="alert">
            {message}
          </div>
        )}
        <section id="configuration" className="config-section" aria-labelledby="providers-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">01 / YOUR TOOLBOX</p>
              <h2 id="providers-heading">Meet your agents.</h2>
              <p>Connecting to local configuration…</p>
            </div>
          </div>
        </section>
        <section className="sync-section" aria-labelledby="sync-heading">
          <h2 id="sync-heading">Everything in its place.</h2>
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
      </main>
    </div>
  );
}

function Console() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const state = snapshot.state;
  useEffect(() => {
    void store.initialize();
    const timer = window.setInterval(() => store.poll(), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!state) return <ConsolePlaceholder message={snapshot.notice?.message} />;
  const configuredProviders = state.providers.filter((provider) =>
    snapshot.selection.providers.includes(provider.id),
  );
  const connection =
    snapshot.connection === 'Loading workspace…'
      ? (state.doctor.project
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop() ?? state.doctor.project)
      : snapshot.connection;
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Workspace navigation">
        <a className="brand" href="#workspace" aria-label="Latchkit workspace">
          <span className="brand-mark" aria-hidden="true">
            l<span>k</span>
          </span>
          <span>
            latchkit<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="sidebar-caption">DEVELOPER WORKSPACE</div>
        <nav aria-label="Primary">
          <a className="nav-item active" href="#workspace">
            <span aria-hidden="true">◈</span>Workspace
          </a>
          <a className="nav-item" href="#configuration">
            <span aria-hidden="true">≡</span>Configuration
          </a>
          <a
            className="nav-item"
            href="https://github.com/willahealm/latchkit#readme"
            target="_blank"
            rel="noreferrer noopener"
          >
            <ExternalLink size={17} aria-hidden="true" />
            Documentation
          </a>
        </nav>
        <div className="sidebar-note">
          <span className="connection-dot" aria-hidden="true" />
          Local to your machine
          <p>
            One workflow.
            <br />
            Your choice of agent.
          </p>
          <span className="version">OPEN SOURCE · 1.0 RELEASE CANDIDATE</span>
        </div>
      </aside>
      <main id="workspace">
        <header className="topbar">
          <div>
            <span className="breadcrumb">WORKSPACE</span>
            <span className="slash">/</span>
            <span>Overview</span>
          </div>
          <div className="topbar-actions">
            <span className="local-pill">
              <span className="connection-dot" aria-hidden="true" />
              Loopback session
            </span>
            <ThemeToggle />
          </div>
        </header>
        <section className="intro">
          <div>
            <p className="eyebrow">LESS SETUP. MORE SHIPPING.</p>
            <h1>
              Your agents,
              <br />
              <span>in sync.</span>
            </h1>
            <p className="intro-copy">
              Give every coding agent a familiar workflow.
              <br />
              Choose your tools. Connect your skills. Keep building.
            </p>
          </div>
          <Card className="workspace-card">
            <span className="mini-label">CURRENT PROJECT</span>
            <strong>{connection}</strong>
            <code>{state.doctor.project}</code>
            <div className="workspace-meta">
              <span>{state.doctor.platform}</span>
              <span>{state.doctor.runtime}</span>
            </div>
          </Card>
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
        <Summary state={state} />
        <FccConsole />
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
        <section className="sync-section" aria-labelledby="sync-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">03 / MAKE IT YOURS</p>
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
              <Button
                onClick={() => void store.preview()}
                disabled={snapshot.busy || store.dirty()}
              >
                Preview sync <ArrowUpRight aria-hidden="true" />
              </Button>
            </div>
          </div>
          <PlanPanel />
        </section>
        <section id="workbench" className="config-section" aria-labelledby="tasks-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">04 / WORKFLOW WORKBENCH</p>
              <h2 id="tasks-heading">Tasks, recovery, and proof.</h2>
              <p>
                Persisted local state is authoritative. Provider actions remain explicit and
                bounded.
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => void store.action(store.reloadWorkbench)}
              disabled={snapshot.busy}
            >
              <RefreshCw aria-hidden="true" />
              Refresh state
            </Button>
          </div>
          <p className="section-note" aria-live="polite">
            {snapshot.workbenchStatus}
          </p>
          <TaskList
            tasks={snapshot.workbench?.tasks.tasks ?? []}
            store={store}
            busy={snapshot.busy}
          />
          <p className="section-note">
            Starting or resuming a provider session requires explicit host-local authorization and
            is intentionally available through the CLI/API only. Cancellation never grants provider
            permissions.
          </p>
        </section>
        <section id="delivery" className="config-section" aria-labelledby="delivery-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">DELIVERY WORKFLOWS</p>
              <h2 id="delivery-heading">From requirements to reviewed changes.</h2>
              <p>
                Review and approve the exact plan before implementation. Verification and an
                independent review precede handoff.
              </p>
            </div>
          </div>
          <WorkflowConsole
            store={store}
            providers={configuredProviders}
            enabled={!snapshot.busy && configuredProviders.length > 0}
            busy={snapshot.busy}
          />
        </section>
        <section id="memory" className="config-section" aria-labelledby="memory-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">05 / PROJECT MEMORY</p>
              <h2 id="memory-heading">Keep only what helps recovery.</h2>
              <p>Inspectable, local records. No transcripts are imported automatically.</p>
            </div>
            <Button
              variant="outline"
              onClick={() => void exportMemory(store)}
              disabled={snapshot.busy}
            >
              Export local memory
            </Button>
          </div>
          <MemoryConsole
            store={store}
            page={snapshot.memory}
            providers={configuredProviders}
            busy={snapshot.busy}
          />
        </section>
        <section className="config-section" aria-labelledby="evidence-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">06 / ACCEPTANCE EVIDENCE</p>
              <h2 id="evidence-heading">What the product proved.</h2>
              <p>
                Current task criteria and bounded runtime evidence from CLI, HTTP, and browser
                checks.
              </p>
            </div>
            <span className="subtle-tag">REVISION-BOUND</span>
          </div>
          <AcceptanceEvidence tasks={snapshot.workbench?.tasks.tasks ?? []} />
        </section>
        <UsageConsole />
        <footer>
          <span className="footer-brand">latchkit.</span>
          <span>Built for the way you work.</span>
          <span className="footer-right">Windows · Linux · macOS</span>
        </footer>
      </main>
    </div>
  );
}

const mount = document.getElementById('root');
if (!mount) throw new Error('The console root is missing.');
createRoot(mount).render(<Console />);
