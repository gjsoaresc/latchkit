import { useState } from 'react';
import { api } from './api.js';
import type { ConsoleStore } from './console-store.js';
import type { Annotations, ConsoleTask, Evidence, Source } from './types.js';
import { Button } from './components/ui/button.js';
import { Input } from './components/ui/fields.js';

function sameSource(left: Source | undefined, right: Source | undefined) {
  return left?.revision === right?.revision && left?.dirtyFingerprint === right?.dirtyFingerprint;
}
function artifactLocation(evidence: Evidence): string | null {
  try {
    const artifact = JSON.parse(evidence.artifact || '{}');
    return typeof artifact.location === 'string' &&
      artifact.location.startsWith('.latchkit/tasks/acceptance-evidence/')
      ? artifact.location
      : null;
  } catch {
    return null;
  }
}
export function AcceptanceEvidence({ tasks }: { tasks: ConsoleTask[] }) {
  const rows = tasks.flatMap((task) =>
    task.criteria.flatMap((criterion) => {
      const evidence = [...task.evidence]
        .reverse()
        .find(
          (item) =>
            item.criterionId === criterion.id && item.criterionRevision === criterion.revision,
        );
      if (!evidence) return [];
      const outcome = sameSource(evidence.source, task.reconciliation?.currentSource)
        ? evidence.outcome
        : 'stale';
      const location = artifactLocation(evidence);
      return [
        <article key={`${task.id}:${criterion.id}`} className="evidence-row">
          <div className="evidence-summary">
            <strong>{criterion.description}</strong>
            <span className={`evidence-outcome outcome-${outcome}`}>{outcome}</span>
          </div>
          {location && <code className="evidence-location">{location}</code>}
        </article>,
      ];
    }),
  );
  return (
    <div id="acceptance-evidence" className="evidence-list" aria-live="polite">
      {rows.length ? rows : <p className="section-note">No task evidence has been recorded.</p>}
    </div>
  );
}

function ReviewFeedback({
  task,
  store,
  busy,
}: {
  task: ConsoleTask;
  store: ConsoleStore;
  busy: boolean;
}) {
  const [annotations, setAnnotations] = useState<Annotations>();
  const [evidenceIds, setEvidenceIds] = useState<Record<string, string>>({});
  const load = async () =>
    setAnnotations(await api<Annotations>(`annotations?taskId=${encodeURIComponent(task.id)}`));
  return (
    <section className="task-review">
      <strong>Revision-bound review feedback</strong>
      <form
        className="annotation-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = new FormData(form);
          void store.action(async () => {
            const [diff, current] = await Promise.all([
              api<{ revision: string }>(`diff?taskId=${encodeURIComponent(task.id)}`),
              api<Annotations>(`annotations?taskId=${encodeURIComponent(task.id)}`),
            ]);
            await api('annotations', {
              method: 'POST',
              body: {
                taskId: task.id,
                path: values.get('path'),
                side: 'right',
                line: Number(values.get('line')),
                body: values.get('body'),
                expectedRevision: diff.revision,
                expectedStoreRevision: current.revision,
              },
            });
            form.reset();
            await load();
          });
        }}
      >
        <Input
          name="path"
          required
          placeholder="Task-worktree path"
          aria-label="Review feedback file path"
        />
        <Input
          name="line"
          required
          type="number"
          min="1"
          defaultValue="1"
          aria-label="Review feedback line number"
        />
        <Input
          name="body"
          required
          placeholder="Untrusted review feedback"
          aria-label="Review feedback text"
        />
        <Button variant="outline" type="submit" disabled={busy}>
          Add feedback
        </Button>
      </form>
      <Button variant="outline" disabled={busy} onClick={() => void store.action(load)}>
        Load review feedback
      </Button>
      <div className="annotation-list">
        {!annotations ? (
          'Load feedback to inspect the current diff revision.'
        ) : !annotations.annotations.length ? (
          <p className="section-note">No review feedback is recorded.</p>
        ) : (
          annotations.annotations.map((annotation) => (
            <article key={annotation.id} className={`annotation annotation-${annotation.status}`}>
              <code>
                {annotation.path}:{annotation.line} ({annotation.side})
              </code>
              <p>{annotation.body}</p>
              <span className="section-note">
                {annotation.stale ? 'Stale: the reviewed revision changed.' : annotation.status}
              </span>
              {annotation.status === 'open' && (
                <>
                  <Input
                    className="annotation-evidence"
                    placeholder="Current task evidence ID required to resolve"
                    aria-label="Evidence ID proving this feedback was resolved"
                    value={evidenceIds[annotation.id] || ''}
                    onChange={(event) =>
                      setEvidenceIds({ ...evidenceIds, [annotation.id]: event.target.value })
                    }
                  />
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void store.action(async () => {
                        await api('annotations/action', {
                          method: 'POST',
                          body: {
                            taskId: task.id,
                            annotationId: annotation.id,
                            action: 'resolve',
                            expectedStoreRevision: annotations.revision,
                            evidenceRevision: annotations.currentRevision,
                            evidenceId: evidenceIds[annotation.id]?.trim() || '',
                          },
                        });
                        await load();
                      })
                    }
                  >
                    Resolve with current revision
                  </Button>
                </>
              )}
              {annotation.status === 'resolved' && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void store.action(async () => {
                      await api('annotations/action', {
                        method: 'POST',
                        body: {
                          taskId: task.id,
                          annotationId: annotation.id,
                          action: 'reopen',
                          expectedStoreRevision: annotations.revision,
                        },
                      });
                      await load();
                    })
                  }
                >
                  Reopen
                </Button>
              )}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

export function TaskList({
  tasks,
  store,
  busy,
}: {
  tasks: ConsoleTask[];
  store: ConsoleStore;
  busy: boolean;
}) {
  return (
    <div id="task-list" className="task-list" aria-live="polite">
      {!tasks.length ? (
        <p className="section-note">No durable tasks have been recorded in this project.</p>
      ) : (
        tasks.map((task) => (
          <details key={task.id} className="task-card">
            <summary>
              <span>{task.title}</span>
              <span className={`state-badge ${task.state}`}>{task.state}</span>
            </summary>
            <div className="task-detail">
              <p className="section-note">
                Revision {task.revision} · process{' '}
                {task.reconciliation?.recordedProcess ?? 'unknown'}
              </p>
              <strong>Acceptance criteria</strong>
              <ul>
                {task.criteria.map((criterion) => {
                  const evidence = [...task.evidence]
                    .reverse()
                    .find(
                      (item) =>
                        item.criterionId === criterion.id &&
                        item.criterionRevision === criterion.revision,
                    );
                  return (
                    <li key={criterion.id}>
                      {criterion.description} — {evidence?.outcome ?? 'missing'}
                    </li>
                  );
                })}
              </ul>
              <ReviewFeedback task={task} store={store} busy={busy} />
              {!!task.checkpoints.length && (
                <p className="section-note">
                  Latest checkpoint: {task.checkpoints.at(-1)?.summary}
                </p>
              )}
              {!['cancelled', 'verified'].includes(task.state) && (
                <div className="task-action-row">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void store.action(async () => {
                        const result = await api('tasks/cancel', {
                          method: 'POST',
                          body: {
                            taskId: task.id,
                            expectedRevision: task.revision,
                            mutationId: crypto.randomUUID(),
                            reason: 'Cancelled from local workbench.',
                          },
                        });
                        store.notice(
                          result.cancelledProcess
                            ? 'Task and its owned local process were cancelled.'
                            : 'Task was cancelled; no owned process was running.',
                        );
                        await store.reloadWorkbench();
                      })
                    }
                  >
                    Cancel task
                  </Button>
                </div>
              )}
            </div>
          </details>
        ))
      )}
    </div>
  );
}
