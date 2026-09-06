import { useCallback, useEffect, useState } from 'react';
import type { WorkflowRecord } from '../src/workflows/contracts.js';
import { api } from './api.js';
import type { ConsoleStore } from './console-store.js';
import { Button } from './components/ui/button.js';
import { Input, Textarea, NativeSelect, Label } from './components/ui/fields.js';

function WorkflowCard({
  workflow,
  store,
  reload,
  busy,
}: {
  workflow: WorkflowRecord;
  store: ConsoleStore;
  reload: () => Promise<void>;
  busy: boolean;
}) {
  const [decision, setDecision] = useState('');
  return (
    <article className="task-card workflow-card">
      <h3>{workflow.initialPrompt}</h3>
      <p>
        {workflow.status} · {workflow.phase} · Repairs {workflow.repairAttempts}/3
      </p>
      <p>{workflow.lastOutcome.summary}</p>
      {(
        [
          ['Requirements', workflow.requirements?.artifact],
          ['Plan', workflow.plan?.artifact],
          [
            'Acceptance checks',
            workflow.plan ? JSON.stringify(workflow.plan.checks, null, 2) : undefined,
          ],
        ] as const
      ).map(
        ([title, content]) =>
          content && (
            <details key={title} open={workflow.status === 'awaiting-approval' ? true : undefined}>
              <summary>{title}</summary>
              <pre>{content}</pre>
            </details>
          ),
      )}
      {workflow.status === 'awaiting-approval' && workflow.plan && workflow.requirements && (
        <form
          className="memory-form"
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void store.action(async () => {
              await api('workflows/approve', {
                method: 'POST',
                body: {
                  taskId: workflow.taskId,
                  expectedRevision: workflow.revision,
                  planDigest: workflow.plan?.digest,
                  requirementsDigest: workflow.requirements?.digest,
                  checksDigest: workflow.plan?.checksDigest,
                  scope: values.get('scope'),
                  reference: values.get('reference'),
                },
              });
              await reload();
            });
          }}
        >
          <Label>
            Authorized change scope
            <Textarea name="scope" required maxLength={4000} />
          </Label>
          <Label>
            Approval reference
            <Input name="reference" required maxLength={1000} />
          </Label>
          <Button type="submit" disabled={busy}>
            Approve this plan and acceptance checks
          </Button>
        </form>
      )}
      {['awaiting-input', 'blocked', 'interrupted'].includes(workflow.status) && (
        <form
          className="memory-form"
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            const prompt = String(values.get('answer') || '');
            void store.action(async () => {
              await api('workflows/resume', {
                method: 'POST',
                body: {
                  taskId: workflow.taskId,
                  expectedRevision: workflow.revision,
                  executionAuthorized: values.get('permission') === 'on',
                  ...(prompt.trim() ? { prompt } : {}),
                  ...(workflow.pendingAction
                    ? {
                        resolution: {
                          actionId: workflow.pendingAction.actionId,
                          decision,
                          ...(decision === 'observed'
                            ? { evidenceId: values.get('evidence') }
                            : {}),
                        },
                      }
                    : {}),
                },
              });
              await reload();
            });
          }}
        >
          {workflow.pendingAction && (
            <>
              <Label>
                Interrupted action
                <NativeSelect
                  name="decision"
                  value={decision}
                  onChange={(event) => setDecision(event.target.value)}
                  required
                >
                  <option value="">Choose how to resolve the interrupted action</option>
                  <option value="observed">Supply observed result</option>
                  <option value="abandon">Abandon this action</option>
                  <option value="retry">Explicitly authorize retry</option>
                </NativeSelect>
              </Label>
              <Label>
                Observed evidence
                <Input
                  name="evidence"
                  placeholder="Persisted task evidence ID"
                  required={decision === 'observed'}
                />
              </Label>
            </>
          )}
          <Label>
            Answers or updated requirements
            <Textarea name="answer" maxLength={16384} />
          </Label>
          <Label className="authorization">
            Authorize local coding-tool execution
            <input name="permission" type="checkbox" required />
          </Label>
          <Button variant="outline" type="submit" disabled={busy}>
            Resume workflow
          </Button>
        </form>
      )}
      {!['cancelled', 'completed', 'verified'].includes(workflow.status) && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void store.action(async () => {
              await api('workflows/cancel', {
                method: 'POST',
                body: { taskId: workflow.taskId, expectedRevision: workflow.revision },
              });
              await reload();
            })
          }
        >
          Cancel workflow
        </Button>
      )}
    </article>
  );
}

export function WorkflowConsole({
  store,
  providers,
  enabled,
  busy,
}: {
  store: ConsoleStore;
  providers: { id: string; label: string }[];
  enabled: boolean;
  busy: boolean;
}) {
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [provider, setProvider] = useState('');
  const [reviewer, setReviewer] = useState('');
  const selected = providers.some((item) => item.id === provider)
    ? provider
    : providers[0]?.id || '';
  const selectedReviewer = providers.some((item) => item.id === reviewer) ? reviewer : '';
  const reload = useCallback(async () => {
    const response = await api<{ workflows: WorkflowRecord[] }>('workflows');
    setWorkflows(response.workflows);
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void api<{ workflows: WorkflowRecord[] }>('workflows')
      .then((response) => {
        if (active) {
          setWorkflows(response.workflows);
          setLoaded(true);
        }
      })
      .catch((error) => {
        if (active) store.notice(error instanceof Error ? error.message : String(error), true);
      });
    return () => {
      active = false;
    };
  }, [enabled, store]);
  return (
    <div id="workflow-console">
      <form
        className="memory-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = new FormData(form);
          void store.action(async () => {
            await api('workflows/run', {
              method: 'POST',
              body: {
                prompt: values.get('prompt'),
                providerId: selected,
                ...(selectedReviewer ? { reviewProviderId: selectedReviewer } : {}),
                executionAuthorized: values.get('authorized') === 'on',
              },
            });
            form.reset();
            await reload();
          });
        }}
      >
        <Label className="memory-text-label">
          What should be delivered?
          <Textarea name="prompt" required maxLength={16384} />
        </Label>
        <Label>
          Coding provider
          <NativeSelect
            value={selected}
            onChange={(event) => setProvider(event.target.value)}
            required
            aria-label="Coding provider"
          >
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </NativeSelect>
        </Label>
        <Label>
          Independent reviewer
          <NativeSelect
            value={selectedReviewer}
            onChange={(event) => setReviewer(event.target.value)}
            aria-label="Independent reviewer"
          >
            <option value="">Use selected provider</option>
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </NativeSelect>
        </Label>
        <Label className="authorization memory-text-label">
          Authorize local coding-tool execution. Implementation waits for plan approval.
          <input name="authorized" type="checkbox" required />
        </Label>
        <Button type="submit" disabled={busy || !enabled || !selected}>
          Start requirements
        </Button>
      </form>
      <Button
        variant="outline"
        className="mt-4"
        disabled={busy || !enabled}
        onClick={() => void store.action(reload)}
      >
        Refresh workflows
      </Button>
      <div className="task-list">
        {workflows.map((workflow) => (
          <WorkflowCard
            key={`${workflow.taskId}:${workflow.revision}`}
            workflow={workflow}
            store={store}
            reload={reload}
            busy={busy}
          />
        ))}
        {!workflows.length && (
          <p className="section-note">
            {loaded
              ? 'No delivery workflows yet.'
              : enabled
                ? 'Loading delivery workflows…'
                : 'Connect this session to load delivery workflows.'}
          </p>
        )}
      </div>
    </div>
  );
}
