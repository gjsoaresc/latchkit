import { useEffect, useSyncExternalStore } from 'react';
import { RefreshCw } from 'lucide-react';
import { createConsoleStore } from './console-store.js';
import { AcceptanceEvidence, TaskList } from './workbench.js';
import { WorkflowConsole } from './workflows.js';
import { Button } from './components/ui/button.js';
import { Shell, ShellPlaceholder, Topbar } from './shell.js';

const store = createConsoleStore();

const TAGLINE = (
  <>
    Plans, tasks, and proof —
    <br />
    one workbench.
  </>
);

export function SpecsConsole() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const state = snapshot.state;
  useEffect(() => {
    void store.initialize();
    const timer = window.setInterval(() => store.poll(), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!state)
    return (
      <ShellPlaceholder
        active="specs"
        tagline={TAGLINE}
        breadcrumb="WORKSPACE"
        label="Specs & Tasks"
        title="Specs, tasks, and delivery."
        message={snapshot.notice?.message}
      />
    );
  const configuredProviders = state.providers.filter((provider) =>
    snapshot.selection.providers.includes(provider.id),
  );
  return (
    <Shell active="specs" tagline={TAGLINE}>
      <Topbar breadcrumb="WORKSPACE" label="Specs & Tasks" />
      <section className="intro intro-compact">
        <div>
          <p className="eyebrow">SPECS AND TASKS</p>
          <h1>Plans, tasks, and proof.</h1>
          <p className="intro-copy">
            Durable local tasks, delivery workflows, and the bounded evidence each acceptance
            criterion collected.
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
      <section id="workbench" className="config-section" aria-labelledby="tasks-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">01 / WORKFLOW WORKBENCH</p>
            <h2 id="tasks-heading">Tasks, recovery, and proof.</h2>
            <p>
              Persisted local state is authoritative. Provider actions remain explicit and bounded.
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
          Starting or resuming a provider session requires explicit host-local authorization and is
          intentionally available through the CLI/API only. Cancellation never grants provider
          permissions.
        </p>
      </section>
      <section id="delivery" className="config-section" aria-labelledby="delivery-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">02 / DELIVERY WORKFLOWS</p>
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
      <section className="config-section" aria-labelledby="evidence-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">03 / ACCEPTANCE EVIDENCE</p>
            <h2 id="evidence-heading">What the product proved.</h2>
            <p>
              Current task criteria and bounded runtime evidence from CLI, HTTP, and browser checks.
            </p>
          </div>
          <span className="subtle-tag">REVISION-BOUND</span>
        </div>
        <AcceptanceEvidence tasks={snapshot.workbench?.tasks.tasks ?? []} />
      </section>
    </Shell>
  );
}
