import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApprovalCoverage,
  CriterionEvidenceStatus,
  CriterionEvidenceView,
  DecisionComparisonEntry,
  DecisionComparisonReport,
} from '../src/reviews/decision-comparison.js';
import type { RecordLinkStatus } from '../src/task-state/records.js';
import { api, hasSession } from './api.js';
import type { ApiError } from './types.js';
import { Shell, ShellPlaceholder, Topbar } from './shell.js';
import { Button } from './components/ui/button.js';
import { Input, Textarea, Label } from './components/ui/fields.js';

/**
 * Issue #113: a directly addressable review of one task's changed decisions and their
 * consequences, reached from Specs & Tasks (`web/workbench.tsx`'s "Review decisions" link) at
 * `/specs/review?task=<id>`. This page only reads `GET /api/reviews/decision-comparison` and, for
 * the two review actions, calls the exact existing #97/#101 shared services through thin
 * additive routes (`/api/reviews/{result,spec}-decision/{approve,notes}`) — it adds no
 * per-decision approval and no independent approval store. #90 owns the shell/nav/theme/a11y
 * foundation this page consumes (`Shell`, `Topbar`, `components/ui/*`) rather than redesigning.
 */

function currentTaskId(): string {
  return new URLSearchParams(location.search).get('task') ?? '';
}

function isConflictError(error: ApiError): boolean {
  const code = error.code ?? '';
  return (
    /_STALE$/.test(code) || /_REVISION_CONFLICT$/.test(code) || /_IDEMPOTENCY_CONFLICT$/.test(code)
  );
}

const CHANGE_LABEL: Record<DecisionComparisonEntry['changeKind'], string> = {
  added: 'Added',
  changed: 'Changed',
  removed: 'Removed',
  unchanged: 'Unchanged',
};

const EVIDENCE_OUTCOME_CLASS: Record<CriterionEvidenceStatus, string> = {
  'current-pass': 'outcome-passed',
  'current-fail': 'outcome-failed',
  stale: 'outcome-stale',
  historical: 'outcome-historical',
  missing: 'outcome-missing',
  'unknown-outcome': 'outcome-unknown-outcome',
};

const LINK_OUTCOME_CLASS: Record<RecordLinkStatus, string> = {
  current: 'outcome-passed',
  stale: 'outcome-stale',
  missing: 'outcome-missing',
  unknown: 'outcome-unknown-outcome',
};

function approvalOutcomeClass(coverage: ApprovalCoverage | null): string {
  if (!coverage || !coverage.present) return 'outcome-missing';
  if (coverage.valid === true) return 'outcome-passed';
  if (coverage.valid === false) return 'outcome-stale';
  return 'outcome-missing';
}

function approvalStatusLabel(coverage: ApprovalCoverage | null): string {
  if (!coverage || !coverage.present) return 'none recorded';
  if (coverage.valid === true) return 'valid';
  if (coverage.valid === false) return 'stale';
  return 'pending';
}

function DecisionEntryCard({ entry }: { entry: DecisionComparisonEntry }) {
  return (
    <article className="task-card decision-card">
      <header className="evidence-summary">
        <strong>
          {entry.recordId} <span className="section-note">({entry.kind})</span>
        </strong>
        <span className={`decision-badge ${entry.changeKind}`}>
          {CHANGE_LABEL[entry.changeKind]}
        </span>
      </header>
      {entry.interpretation && (
        <p className="section-note">
          Interpretation: agent-inferred, not a confirmed user decision (
          {entry.provenance.reference}).
        </p>
      )}
      {!entry.interpretation && (
        <p className="section-note">
          Provenance: {entry.provenance.kind} ({entry.provenance.reference}).
        </p>
      )}
      {entry.before ? (
        <p>
          <strong>Before</strong> (revision {entry.before.revision}, {entry.before.status}):{' '}
          {entry.before.text}
        </p>
      ) : (
        <p className="section-note">
          No prior recorded state; this decision is new since the baseline.
        </p>
      )}
      {entry.after && (
        <p>
          <strong>After</strong> (revision {entry.after.revision}, {entry.after.status}):{' '}
          {entry.after.text}
        </p>
      )}
      {(entry.supersedes || entry.supersededBy) && (
        <p className="section-note">
          {entry.supersedes && <>Supersedes {entry.supersedes}. </>}
          {entry.supersededBy && <>Superseded by {entry.supersededBy}.</>}
        </p>
      )}
      {!!entry.reasons.length && (
        <ul>
          {entry.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      )}
      {!!entry.sourceLinks.length && (
        <ul>
          {entry.sourceLinks.map((link) => (
            <li key={link.path}>
              <code>{link.path}</code>{' '}
              <span className={`evidence-outcome ${LINK_OUTCOME_CLASS[link.status]}`}>
                {link.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function EvidenceRow({ item, taskId }: { item: CriterionEvidenceView; taskId: string }) {
  const [artifact, setArtifact] = useState<string>();
  const [loading, setLoading] = useState(false);
  return (
    <article className="evidence-row">
      <div className="evidence-summary">
        <strong>
          {item.description}
          {item.required ? ' (required)' : ''}
        </strong>
        <span className={`evidence-outcome ${EVIDENCE_OUTCOME_CLASS[item.status]}`}>
          {item.status}
        </span>
      </div>
      {item.checkIds.length > 0 && (
        <p className="section-note">Checks: {item.checkIds.join(', ')}</p>
      )}
      {item.reason && <p className="section-note">{item.reason}</p>}
      {item.evidenceId && (
        <>
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              void api<{ artifact: unknown }>(
                `tasks/artifact?taskId=${encodeURIComponent(taskId)}&evidenceId=${encodeURIComponent(item.evidenceId!)}`,
              )
                .then((result) => setArtifact(JSON.stringify(result.artifact, null, 2)))
                .catch((error) => setArtifact(`Artifact unavailable: ${(error as Error).message}`))
                .finally(() => setLoading(false));
            }}
          >
            View recorded evidence
          </Button>
          {artifact && <pre className="evidence-location">{artifact}</pre>}
        </>
      )}
    </article>
  );
}

function ApprovalCard({
  label,
  coverage,
  notes,
}: {
  label: string;
  coverage: ApprovalCoverage | null;
  notes?: { id: string; text: string; createdAt: string }[];
}) {
  return (
    <article className="evidence-row">
      <div className="evidence-summary">
        <strong>{label}</strong>
        <span className={`evidence-outcome ${approvalOutcomeClass(coverage)}`}>
          {approvalStatusLabel(coverage)}
        </span>
      </div>
      {coverage?.scope && <p className="section-note">Scope: {coverage.scope}</p>}
      {coverage?.reference && <p className="section-note">Reference: {coverage.reference}</p>}
      {coverage?.approvedAt && <p className="section-note">Approved at {coverage.approvedAt}.</p>}
      {!!coverage?.staleReasons.length && (
        <ul>
          {coverage.staleReasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      )}
      {!!notes?.length && (
        <>
          <strong>Unresolved feedback (carried forward on later revisions)</strong>
          <ul>
            {notes.map((note) => (
              <li key={note.id}>
                {note.text} <span className="section-note">({note.createdAt})</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}

export function ReviewConsole() {
  const [taskId] = useState(currentTaskId);
  const [report, setReport] = useState<DecisionComparisonReport>();
  const [baselineInput, setBaselineInput] = useState('');
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<{ message: string; error: boolean }>();
  const noticeRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (baselineRevision?: number) => {
      if (!taskId) return;
      setBusy(true);
      try {
        const query = new URLSearchParams({ task: taskId });
        if (baselineRevision !== undefined) query.set('baselineRevision', String(baselineRevision));
        const result = await api<{ report: DecisionComparisonReport }>(
          `reviews/decision-comparison?${query.toString()}`,
        );
        setReport(result.report);
      } catch (error) {
        setNotice({ message: (error as ApiError).message, error: true });
      } finally {
        setBusy(false);
      }
    },
    [taskId],
  );

  useEffect(() => {
    if (!hasSession()) {
      setBusy(false);
      setNotice({
        message: 'Open the complete session URL printed by Latchkit to connect this dashboard.',
        error: true,
      });
      return;
    }
    void load();
  }, [load]);

  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  async function runAction(operation: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    try {
      await operation();
      setNotice({ message: successMessage, error: false });
      await load();
    } catch (error) {
      const apiError = error as ApiError;
      if (isConflictError(apiError)) {
        setNotice({
          message:
            'This task changed since the comparison was loaded. The comparison has been refreshed — review the current state before retrying.',
          error: true,
        });
        await load();
      } else {
        setNotice({ message: apiError.message, error: true });
        setBusy(false);
      }
    }
  }

  if (!taskId)
    return (
      <ShellPlaceholder
        active="specs"
        tagline="Review changed decisions."
        breadcrumb="Specs & Tasks"
        label="Review"
        title="A task is required."
        message="Open this page from a task on the Specs & Tasks page (?task=task_<id>)."
      />
    );

  if (!report)
    return (
      <ShellPlaceholder
        active="specs"
        tagline="Review changed decisions."
        breadcrumb="Specs & Tasks"
        label="Review"
        title="Loading the decision comparison."
        message={notice?.message}
      />
    );

  const changed = report.decisions.filter((entry) => entry.changeKind !== 'unchanged');
  const unchanged = report.decisions.filter((entry) => entry.changeKind === 'unchanged');
  const consequences = report.impact.filter((item) => item.classification === 'declared-dependent');
  const resultDecision = report.resultDecision;
  const specDecision = report.specDecision;
  const canActOnResult = resultDecision && resultDecision.status !== 'approved';
  const canActOnSpec = !resultDecision && specDecision && specDecision.status !== 'approved';

  return (
    <Shell active="specs" tagline="Review changed decisions.">
      <Topbar breadcrumb="Specs & Tasks" breadcrumbHref="/specs" label="Review" />
      <section className="intro intro-compact">
        <div>
          <p className="eyebrow">DECISION REVIEW</p>
          <h1>{report.taskTitle}</h1>
          <p className="intro-copy">
            Task {report.taskId} · state {report.taskState} · revision {report.taskRevision}
          </p>
        </div>
      </section>
      {notice && (
        <div
          ref={noticeRef}
          className={`notice ${notice.error ? 'notice-error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
          aria-live="polite"
          tabIndex={-1}
        >
          {notice.message}
        </div>
      )}
      <section className="config-section" aria-labelledby="baseline-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">01 / COMPARISON BASELINE</p>
            <h2 id="baseline-heading">
              {report.baseline.kind === 'initial'
                ? 'Initial review — no prior reviewed snapshot.'
                : report.baseline.kind === 'previous-review'
                  ? `Compared against the previously reviewed snapshot (task revision ${report.baseline.taskRevision}).`
                  : `Compared against explicitly selected task revision ${report.baseline.taskRevision}.`}
            </h2>
          </div>
        </div>
        <form
          className="memory-form"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = Number(baselineInput);
            void load(baselineInput.trim() ? parsed : undefined);
          }}
        >
          <Label>
            Explicit retained task revision to compare against (optional)
            <Input
              type="number"
              min={1}
              max={report.taskRevision}
              value={baselineInput}
              onChange={(event) => setBaselineInput(event.target.value)}
              placeholder="Default: previously reviewed snapshot"
            />
          </Label>
          <Button type="submit" variant="outline" disabled={busy}>
            Compare
          </Button>
          {baselineInput && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setBaselineInput('');
                void load(undefined);
              }}
            >
              Use derived baseline
            </Button>
          )}
        </form>
      </section>
      <section className="config-section" aria-labelledby="decisions-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">02 / RECORDED DECISIONS</p>
            <h2 id="decisions-heading">
              {report.hasDecisionRecords
                ? `${changed.length} changed of ${report.decisions.length} recorded.`
                : 'No structured decision records.'}
            </h2>
            <p>{report.coverageNote}</p>
          </div>
        </div>
        <div className="task-list" aria-live="polite">
          {changed.length ? (
            changed.map((entry) => <DecisionEntryCard key={entry.recordId} entry={entry} />)
          ) : (
            <p className="section-note">No decisions changed since the comparison baseline.</p>
          )}
        </div>
        {!!unchanged.length && (
          <details>
            <summary>{unchanged.length} unchanged decision(s)</summary>
            <div className="task-list">
              {unchanged.map((entry) => (
                <DecisionEntryCard key={entry.recordId} entry={entry} />
              ))}
            </div>
          </details>
        )}
        <p className="section-note">
          {report.sourceDiff.available
            ? 'The complete source diff is reachable at GET /api/diff?taskId=… (or latchkit diff inspect --task …).'
            : `Complete source diff unavailable: ${report.sourceDiff.reason ?? 'unknown reason'}.`}
        </p>
      </section>
      {(!!consequences.length || !!report.uncoveredRequiredCriteria.length) && (
        <section className="config-section" aria-labelledby="consequences-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">03 / DECLARED CONSEQUENCES</p>
              <h2 id="consequences-heading">
                Explicit relationships only — never inferred from filenames.
              </h2>
              <p>
                Reached by following declared record/criterion links from every changed decision.
                {report.impactTruncated ? ' The list below is truncated.' : ''}
              </p>
            </div>
          </div>
          {!!consequences.length && (
            <ul>
              {consequences.map((item) => (
                <li key={`${item.kind}:${item.id}`}>
                  <code>
                    {item.kind}:{item.id}
                  </code>{' '}
                  — {item.outcome} ({item.reasonCode}; via {item.path.join(' → ')})
                </li>
              ))}
            </ul>
          )}
          {!!report.uncoveredRequiredCriteria.length && (
            <p className="section-note">
              Required criteria with no declared decision link — this never proves independence:{' '}
              {report.uncoveredRequiredCriteria.join(', ')}
            </p>
          )}
        </section>
      )}
      <section className="config-section" aria-labelledby="evidence-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">04 / IMPLEMENTATION STATUS AND EVIDENCE</p>
            <h2 id="evidence-heading">
              {report.verification.verifiable
                ? 'Currently verifiable.'
                : 'Not currently verifiable.'}
            </h2>
            {!!report.verification.failures.length && (
              <p>
                {report.verification.failures
                  .map((item) => `${item.criterionId}: ${item.reason}`)
                  .join('; ')}
              </p>
            )}
          </div>
        </div>
        <div className="evidence-list">
          {report.evidence.map((item) => (
            <EvidenceRow key={item.criterionId} item={item} taskId={report.taskId} />
          ))}
        </div>
      </section>
      <section className="config-section" aria-labelledby="approval-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">05 / AUTHORIZATION COVERAGE</p>
            <h2 id="approval-heading">What existing approval actually covers.</h2>
            <p>
              Review actions here route through the existing plan-approval, spec-decision, and
              result-decision services and their own revision checks — no per-decision approval is
              added.
            </p>
          </div>
        </div>
        <div className="evidence-list">
          <ApprovalCard
            label="Delivery workflow plan approval"
            coverage={report.approvals.workflow}
          />
          <ApprovalCard
            label="Spec decision (end-of-spec)"
            coverage={report.approvals.specDecision}
            notes={specDecision?.notes}
          />
          <ApprovalCard
            label="Result decision (end-of-execution)"
            coverage={report.approvals.resultDecision}
            notes={resultDecision?.notes}
          />
        </div>
        {canActOnResult && resultDecision && (
          <form
            className="memory-form"
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              const notes = String(values.get('notes') || '').trim();
              const anchor = String(values.get('anchor') || '').trim();
              void runAction(
                async () => {
                  if (notes) {
                    await api('reviews/result-decision/notes', {
                      method: 'POST',
                      body: {
                        taskId: report.taskId,
                        expectedRevision: resultDecision.revision,
                        resultDigest: resultDecision.resultDigest,
                        notes: anchor ? `Re: ${anchor} — ${notes}` : notes,
                      },
                    });
                  } else {
                    await api('reviews/result-decision/approve', {
                      method: 'POST',
                      body: {
                        taskId: report.taskId,
                        expectedRevision: resultDecision.revision,
                        resultDigest: resultDecision.resultDigest,
                      },
                    });
                  }
                },
                notes ? 'Requested changes were recorded.' : 'The result was approved.',
              );
            }}
          >
            <Label>
              Anchor to a specific decision or source (optional)
              <Input name="anchor" placeholder="e.g. a decision ID from above" />
            </Label>
            <Label>
              Requested changes (leave blank to approve the result as shown)
              <Textarea name="notes" maxLength={8000} />
            </Label>
            <Button type="submit" disabled={busy}>
              Submit
            </Button>
          </form>
        )}
        {canActOnSpec && specDecision && (
          <form
            className="memory-form"
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              const notes = String(values.get('notes') || '').trim();
              const anchor = String(values.get('anchor') || '').trim();
              void runAction(
                async () => {
                  if (notes) {
                    await api('reviews/spec-decision/notes', {
                      method: 'POST',
                      body: {
                        taskId: report.taskId,
                        expectedRevision: specDecision.revision,
                        planDigest: specDecision.planDigest,
                        notes: anchor ? `Re: ${anchor} — ${notes}` : notes,
                      },
                    });
                  } else {
                    await api('reviews/spec-decision/approve', {
                      method: 'POST',
                      body: {
                        taskId: report.taskId,
                        expectedRevision: specDecision.revision,
                        planDigest: specDecision.planDigest,
                        scope: values.get('scope'),
                        reference: values.get('reference'),
                      },
                    });
                  }
                },
                notes ? 'Revision notes were recorded.' : 'The plan was approved.',
              );
            }}
          >
            <Label>
              Anchor to a specific decision or source (optional)
              <Input name="anchor" placeholder="e.g. a decision ID from above" />
            </Label>
            <Label>
              Revision notes (leave blank to approve and build)
              <Textarea name="notes" maxLength={8000} />
            </Label>
            <Label>
              Authorized change scope (required to approve)
              <Textarea name="scope" maxLength={4000} />
            </Label>
            <Label>
              Approval reference (required to approve)
              <Input name="reference" maxLength={1000} />
            </Label>
            <Button type="submit" disabled={busy}>
              Submit
            </Button>
          </form>
        )}
        {!canActOnResult && !canActOnSpec && (
          <p className="section-note">
            {resultDecision?.status === 'approved' || specDecision?.status === 'approved'
              ? 'The current snapshot is already approved. Opening or refreshing this view causes no prompt or execution.'
              : 'No end-of-spec or end-of-execution decision is pending review for this task yet.'}
          </p>
        )}
      </section>
    </Shell>
  );
}
