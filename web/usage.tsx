import { useEffect, useState } from 'react';
import type { inspectUsage } from '../src/usage/service.js';
import type { UsageAggregate, UsageBucketTotals } from '../src/usage/aggregate.js';
import type { SavingsBaseline, SavingsUnits } from '../src/usage/baseline-contracts.js';
import type { SavingsResult } from '../src/usage/savings.js';
import { api } from './api.js';
import { Button } from './components/ui/button.js';
import { Input, Label, NativeSelect, Textarea } from './components/ui/fields.js';

type Usage = Awaited<ReturnType<typeof inspectUsage>>;
type BaselineList = { project: { id: string }; revision: number; baselines: SavingsBaseline[] };
const count = (value: number | null) => (value === null ? 'Unknown' : value.toLocaleString());
const money = (value: number | null) => (value === null ? 'Unknown' : `$${value.toFixed(4)}`);
const dayStart = (date: string) => `${date}T00:00:00.000Z`;
const dayEnd = (date: string) => `${date}T23:59:59.999Z`;

function CoverageCard({ label, totals }: { label: string; totals: UsageBucketTotals }) {
  return (
    <li className="task-card">
      <details>
        <summary>
          {label} · {totals.recordCount} session{totals.recordCount === 1 ? '' : 's'}
          {totals.unavailableCount ? ` · ${totals.unavailableCount} unavailable` : ''}
        </summary>
        <dl>
          <dt>Measured / partial / unavailable</dt>
          <dd>
            {totals.measuredCount} / {totals.partialCount} / {totals.unavailableCount}
          </dd>
          <dt>Input / output tokens</dt>
          <dd>
            {count(totals.tokens.input)} / {count(totals.tokens.output)}
          </dd>
          <dt>Known input / output tokens</dt>
          <dd>
            {totals.knownTokens.input.toLocaleString()} /{' '}
            {totals.knownTokens.output.toLocaleString()}
          </dd>
          <dt>Estimated cost (complete only)</dt>
          <dd>{money(totals.estimatedUsd)}</dd>
          <dt>Known estimated cost</dt>
          <dd>
            {money(totals.knownEstimatedUsd)}
            {totals.priceMissingCount
              ? ` (${totals.priceMissingCount} record(s) missing a price)`
              : ''}
          </dd>
          <dt>Contributing sessions</dt>
          <dd>{totals.recordIds.join(', ') || 'None'}</dd>
        </dl>
      </details>
    </li>
  );
}

function OverviewSection({ busy, notify }: { busy: boolean; notify: (message: string) => void }) {
  const [overview, setOverview] = useState<UsageAggregate>();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (from) query.set('from', dayStart(from));
      if (to) query.set('to', dayEnd(to));
      const suffix = query.toString();
      setOverview(await api<UsageAggregate>(`usage/overview${suffix ? `?${suffix}` : ''}`));
    } catch (failure) {
      notify(
        failure instanceof Error ? failure.message : 'The usage overview could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <h3>Totals and trends</h3>
      <p className="section-note">
        Totals and trends by date, project, provider, and model. Every total distinguishes measured
        usage from partial or unknown counters instead of showing missing data as zero.
      </p>
      <form
        className="memory-controls"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <Label htmlFor="usage-overview-from">
          From
          <Input
            id="usage-overview-from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </Label>
        <Label htmlFor="usage-overview-to">
          To
          <Input
            id="usage-overview-to"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </Label>
        <Button
          id="usage-overview-refresh"
          type="submit"
          variant="outline"
          disabled={busy || loading}
        >
          Apply range
        </Button>
      </form>
      {overview && (
        <>
          <div className="summary-grid" aria-label="Usage overview totals">
            <div className="summary-card">
              <span className="mini-label">SESSIONS IN RANGE</span>
              <div>
                <strong>{overview.totals.recordCount}</strong>
                <span>{overview.totals.unavailableCount} unavailable</span>
              </div>
            </div>
            <div className="summary-card">
              <span className="mini-label">KNOWN INPUT TOKENS</span>
              <div>
                <strong>{overview.totals.knownTokens.input.toLocaleString()}</strong>
              </div>
            </div>
            <div className="summary-card">
              <span className="mini-label">KNOWN OUTPUT TOKENS</span>
              <div>
                <strong>{overview.totals.knownTokens.output.toLocaleString()}</strong>
              </div>
            </div>
            <div className="summary-card">
              <span className="mini-label">ESTIMATED COST</span>
              <div>
                <strong>{money(overview.totals.estimatedUsd)}</strong>
                <span>
                  {overview.totals.priceMissingCount
                    ? `${overview.totals.priceMissingCount} missing a price`
                    : 'Fully priced'}
                </span>
              </div>
            </div>
          </div>
          <p className="section-note">
            Actual provider billing status: {overview.billing.status}. {overview.billing.reason}
          </p>
          <h4>By date</h4>
          {overview.byDate.length ? (
            <ul className="task-list" aria-label="Usage by date">
              {overview.byDate.map((bucket) => (
                <CoverageCard key={bucket.date} label={bucket.date} totals={bucket} />
              ))}
            </ul>
          ) : (
            <p>No usage in this range.</p>
          )}
          <h4>By project</h4>
          <ul className="task-list" aria-label="Usage by project">
            {overview.byProject.map((bucket) => (
              <CoverageCard key={bucket.projectId} label={bucket.projectId} totals={bucket} />
            ))}
          </ul>
          <h4>By provider</h4>
          <ul className="task-list" aria-label="Usage by provider">
            {overview.byProvider.map((bucket) => (
              <CoverageCard key={bucket.provider} label={bucket.provider} totals={bucket} />
            ))}
          </ul>
          <h4>By model</h4>
          <ul className="task-list" aria-label="Usage by model">
            {overview.byModel.map((bucket) => (
              <CoverageCard
                key={`${bucket.provider}:${bucket.model ?? ''}`}
                label={`${bucket.provider} · ${bucket.model ?? 'Unknown model'}`}
                totals={bucket}
              />
            ))}
          </ul>
          <h4>By role (coordinator / worker / planning / verification / tool-model)</h4>
          {overview.byRole.length ? (
            <ul className="task-list" aria-label="Usage by role">
              {overview.byRole.map((bucket) => (
                <li key={bucket.role} className="task-card">
                  <details>
                    <summary>
                      {bucket.role} · {bucket.recordCount} session
                      {bucket.recordCount === 1 ? '' : 's'}
                    </summary>
                    <p>{bucket.note}</p>
                  </details>
                </li>
              ))}
            </ul>
          ) : (
            <p>No usage in this range.</p>
          )}
        </>
      )}
    </>
  );
}

function scopeSummary(baseline: SavingsBaseline): string {
  const parts: string[] = [];
  if (baseline.scope.from && baseline.scope.to)
    parts.push(`${baseline.scope.from.slice(0, 10)} to ${baseline.scope.to.slice(0, 10)}`);
  if (baseline.scope.taskIds.length) parts.push(`tasks: ${baseline.scope.taskIds.join(', ')}`);
  return parts.join(' · ') || 'No explicit scope';
}

function BaselinesSection({
  baselines,
  busy,
  reload,
  notify,
  action,
}: {
  baselines?: BaselineList;
  busy: boolean;
  reload: () => Promise<void>;
  notify: (message: string) => void;
  action: (run: () => Promise<void>) => Promise<void>;
}) {
  const [units, setUnits] = useState<SavingsUnits>('usd');
  return (
    <>
      <h3>Savings baselines</h3>
      <p className="section-note">
        A baseline is an explicit, user-entered comparison point: its source, comparison period or
        task scope, provider/model settings, units, and assumptions are all recorded so the
        comparison is reproducible. Separate controlled paired comparisons from historical estimates
        using the kind field.
      </p>
      <form
        id="baseline-create-form"
        className="memory-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = new FormData(form);
          const from = String(values.get('scopeFrom') || '');
          const to = String(values.get('scopeTo') || '');
          const taskIds = String(values.get('taskIds') || '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
          const pricingUrl = String(values.get('pricingUrl') || '').trim();
          void action(async () => {
            await api('usage/baselines', {
              method: 'POST',
              body: {
                label: values.get('label'),
                kind: values.get('kind'),
                source: values.get('source'),
                scope: {
                  from: from ? dayStart(from) : null,
                  to: to ? dayEnd(to) : null,
                  taskIds,
                  description: values.get('scopeDescription'),
                },
                providerSettings: {
                  provider: String(values.get('provider') || '') || null,
                  model: String(values.get('model') || '') || null,
                  notes: values.get('providerNotes') || '',
                },
                units,
                tokenField: units === 'tokens' ? values.get('tokenField') : undefined,
                amount: Number(values.get('amount')),
                currency: units === 'usd' ? 'USD' : undefined,
                assumptions: values.get('assumptions'),
                pricing: pricingUrl
                  ? {
                      sourceUrl: pricingUrl,
                      sourceVersion: values.get('pricingVersion'),
                      asOf: values.get('pricingAsOf'),
                    }
                  : null,
              },
            });
            form.reset();
            notify('Savings baseline recorded locally.');
            await reload();
          });
        }}
      >
        <Label>
          Label <Input name="label" required maxLength={200} />
        </Label>
        <Label>
          Kind
          <NativeSelect name="kind" required defaultValue="paired">
            <option value="paired">Paired (controlled comparison)</option>
            <option value="historical">Historical estimate</option>
          </NativeSelect>
        </Label>
        <Label className="memory-text-label">
          Source
          <Input
            name="source"
            required
            maxLength={2000}
            placeholder="Where this number came from"
          />
        </Label>
        <Label>
          Comparison period from
          <Input name="scopeFrom" type="date" />
        </Label>
        <Label>
          Comparison period to
          <Input name="scopeTo" type="date" />
        </Label>
        <Label className="memory-text-label">
          Task IDs (comma-separated, optional)
          <Input name="taskIds" placeholder="task_one, task_two" />
        </Label>
        <Label className="memory-text-label">
          Scope description
          <Input name="scopeDescription" required maxLength={4000} />
        </Label>
        <Label>
          Provider assumed
          <Input name="provider" placeholder="e.g. claude" />
        </Label>
        <Label>
          Model assumed
          <Input name="model" placeholder="e.g. claude-opus" />
        </Label>
        <Label>
          Units
          <NativeSelect
            name="units"
            value={units}
            onChange={(event) => setUnits(event.target.value as SavingsUnits)}
          >
            <option value="usd">Monetary (USD)</option>
            <option value="tokens">Tokens</option>
          </NativeSelect>
        </Label>
        {units === 'tokens' && (
          <Label>
            Token field
            <NativeSelect name="tokenField" defaultValue="total">
              <option value="total">Total (all fields)</option>
              <option value="input">Input</option>
              <option value="output">Output</option>
              <option value="cacheRead">Cache read</option>
              <option value="cacheCreation">Cache creation</option>
              <option value="thinking">Thinking</option>
            </NativeSelect>
          </Label>
        )}
        <Label>
          Baseline amount {units === 'usd' ? '(USD)' : '(tokens)'}
          <Input name="amount" type="number" min={0} step="any" required />
        </Label>
        <Label className="memory-text-label">
          Assumptions
          <Textarea name="assumptions" required maxLength={4000} />
        </Label>
        <Label className="memory-text-label">
          Provider notes (optional)
          <Input name="providerNotes" maxLength={4000} />
        </Label>
        <Label>
          Pricing source URL (optional)
          <Input name="pricingUrl" type="url" placeholder="https://…" />
        </Label>
        <Label>
          Pricing version/date (optional)
          <Input name="pricingVersion" />
        </Label>
        <Label>
          Pricing as-of (optional)
          <Input name="pricingAsOf" type="date" />
        </Label>
        <Button type="submit" disabled={busy}>
          Add baseline
        </Button>
      </form>
      {baselines?.baselines.length ? (
        <ul className="task-list" aria-label="Savings baselines">
          {baselines.baselines.map((baseline) => (
            <li key={baseline.id} className="task-card">
              <details>
                <summary>
                  {baseline.label} · {baseline.kind} · {baseline.units === 'usd' ? '$' : ''}
                  {baseline.amount}
                  {baseline.units === 'tokens' ? ` ${baseline.tokenField} tokens` : ''}
                </summary>
                <dl>
                  <dt>Source</dt>
                  <dd>{baseline.source}</dd>
                  <dt>Scope</dt>
                  <dd>{scopeSummary(baseline)}</dd>
                  <dd>{baseline.scope.description}</dd>
                  <dt>Provider settings</dt>
                  <dd>
                    {baseline.providerSettings.provider ?? 'Unknown provider'} ·{' '}
                    {baseline.providerSettings.model ?? 'Unknown model'}
                  </dd>
                  <dt>Assumptions</dt>
                  <dd>{baseline.assumptions}</dd>
                  {baseline.pricing && (
                    <>
                      <dt>Pricing source</dt>
                      <dd>
                        {baseline.pricing.sourceUrl} · {baseline.pricing.sourceVersion} · as of{' '}
                        {baseline.pricing.asOf}
                      </dd>
                    </>
                  )}
                </dl>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api(`usage/baselines/${baseline.id}`, { method: 'DELETE' });
                      notify('Savings baseline deleted.');
                      await reload();
                    })
                  }
                >
                  Delete baseline
                </Button>
              </details>
            </li>
          ))}
        </ul>
      ) : (
        <p>No savings baselines recorded yet.</p>
      )}
    </>
  );
}

function savingsHeadline(result: SavingsResult): string {
  switch (result.status) {
    case 'missing-baseline':
      return 'No baseline selected.';
    case 'incomplete-comparison':
      return 'Comparison is incomplete.';
    case 'missing-prices':
      return 'Monetary comparison is incomplete: some usage has no price.';
    case 'zero-denominator':
      return 'The baseline amount is zero.';
    case 'ok': {
      const unit = result.units === 'usd' ? '$' : '';
      const abs = `${unit}${Math.abs(result.absoluteDifference).toFixed(result.units === 'usd' ? 4 : 0)}`;
      if (result.direction === 'savings')
        return `Savings of ${abs} (${result.percentDifference.toFixed(1)}%).`;
      if (result.direction === 'loss')
        return `${abs} more than the baseline (${Math.abs(result.percentDifference).toFixed(1)}% over).`;
      return 'No difference from the baseline.';
    }
    default:
      return '';
  }
}

function SavingsSection({
  baselines,
  busy,
  notify,
}: {
  baselines?: BaselineList;
  busy: boolean;
  notify: (message: string) => void;
}) {
  const [selected, setSelected] = useState('');
  const [result, setResult] = useState<SavingsResult>();
  const [loading, setLoading] = useState(false);
  const options = baselines?.baselines ?? [];
  const current = options.some((item) => item.id === selected) ? selected : (options[0]?.id ?? '');
  async function compute(baselineId: string) {
    if (!baselineId) {
      setResult(undefined);
      return;
    }
    setLoading(true);
    try {
      setResult(
        await api<SavingsResult>(`usage/savings?baselineId=${encodeURIComponent(baselineId)}`),
      );
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : 'Savings could not be computed.');
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <h3>Savings comparison</h3>
      <p className="section-note">
        Absolute and percentage differences against the selected baseline, with positive, zero, and
        negative outcomes shown explicitly. A missing baseline, incomplete comparison, missing
        price, or zero baseline amount produces a clear explanation rather than an invented number.
      </p>
      <form
        className="memory-controls"
        onSubmit={(event) => {
          event.preventDefault();
          void compute(current);
        }}
      >
        <Label htmlFor="savings-baseline">
          Baseline
          <NativeSelect
            id="savings-baseline"
            value={current}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Select a baseline…</option>
            {options.map((baseline) => (
              <option key={baseline.id} value={baseline.id}>
                {baseline.label} ({baseline.kind})
              </option>
            ))}
          </NativeSelect>
        </Label>
        <Button type="submit" disabled={busy || loading || !current}>
          Compute savings
        </Button>
      </form>
      {result && (
        <div className="summary-grid" aria-label="Savings result">
          <div className="summary-card">
            <span className="mini-label">RESULT</span>
            <div>
              <strong>{savingsHeadline(result)}</strong>
            </div>
          </div>
          {result.status === 'ok' && (
            <>
              <div className="summary-card">
                <span className="mini-label">BASELINE</span>
                <div>
                  <strong>
                    {result.units === 'usd'
                      ? `$${result.baselineAmount.toFixed(4)}`
                      : result.baselineAmount}
                  </strong>
                </div>
              </div>
              <div className="summary-card">
                <span className="mini-label">ACTUAL (MEASURED)</span>
                <div>
                  <strong>
                    {result.units === 'usd'
                      ? `$${result.actualAmount.toFixed(4)}`
                      : result.actualAmount}
                  </strong>
                </div>
              </div>
              <div className="summary-card">
                <span className="mini-label">DIRECTION</span>
                <div>
                  <strong>{result.direction}</strong>
                  <span>{result.kind} comparison</span>
                </div>
              </div>
            </>
          )}
          {'reason' in result && <p className="section-note">{result.reason}</p>}
          {'match' in result && (
            <p className="section-note">
              Matched {result.match.recordCount} session(s): {result.match.measuredCount} measured,{' '}
              {result.match.partialCount} partial, {result.match.unavailableCount} unavailable.
            </p>
          )}
        </div>
      )}
    </>
  );
}

export function UsageConsole() {
  const [usage, setUsage] = useState<Usage>();
  const [baselines, setBaselines] = useState<BaselineList>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retention, setRetention] = useState(30);
  const [deleting, setDeleting] = useState(false);
  async function refresh() {
    const next = await api<Usage>('usage');
    setUsage(next);
    setRetention(next.settings.retentionDays);
  }
  async function refreshBaselines() {
    setBaselines(await api<BaselineList>('usage/baselines'));
  }
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await run();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Usage could not be loaded.');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void action(async () => {
      await Promise.all([refresh(), refreshBaselines()]);
    });
  }, []);
  async function configure(enabled: boolean) {
    await api('usage/settings', { method: 'POST', body: { enabled, retentionDays: retention } });
    await refresh();
  }
  return (
    <section id="usage" className="config-section" aria-labelledby="usage-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">07 / LOCAL USAGE</p>
          <h2 id="usage-heading">Understand each session.</h2>
          <p>
            Optional local counters, with missing data clearly marked. Actual provider billing is
            unknown.
          </p>
        </div>
        <Button variant="outline" disabled={busy} onClick={() => void action(refresh)}>
          Refresh usage
        </Button>
      </div>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}
      {usage && (
        <>
          <form
            className="memory-controls"
            onSubmit={(event) => {
              event.preventDefault();
              void action(() => configure(usage.settings.enabled));
            }}
          >
            <Label>
              Retention days
              <Input
                type="number"
                min={1}
                max={365}
                required
                value={retention}
                onChange={(event) => setRetention(Number(event.target.value))}
              />
            </Label>
            <Button type="submit" variant="outline" disabled={busy}>
              Save retention
            </Button>
            <Button
              disabled={busy}
              onClick={() => void action(() => configure(!usage.settings.enabled))}
            >
              {usage.settings.enabled ? 'Disable collection' : 'Enable local collection'}
            </Button>
            <span>{usage.settings.enabled ? 'Collection enabled' : 'Collection disabled'}</span>
          </form>
          <p className="section-note">
            Only documented usage events from sessions started through Latchkit are collected. No
            transcripts are imported automatically. Missing totals are never treated as zero.
          </p>
          <div className="summary-grid" aria-label="Recorded usage totals">
            <div className="summary-card">
              <span className="mini-label">INPUT TOKENS</span>
              <div>
                <strong>{count(usage.summary.tokens.input)}</strong>
              </div>
            </div>
            <div className="summary-card">
              <span className="mini-label">OUTPUT TOKENS</span>
              <div>
                <strong>{count(usage.summary.tokens.output)}</strong>
              </div>
            </div>
            <div className="summary-card">
              <span className="mini-label">RECORDED SESSIONS</span>
              <div>
                <strong>{usage.summary.records}</strong>
                <span>{usage.summary.unavailable} unavailable</span>
              </div>
            </div>
          </div>
          <OverviewSection busy={busy} notify={(message) => setError(message)} />
          {usage.records.length ? (
            <>
              <h3>Sessions</h3>
              <ul className="task-list" aria-label="Session usage">
                {usage.records
                  .slice()
                  .reverse()
                  .slice(0, 100)
                  .map((record) => (
                    <li key={record.id} className="task-card">
                      <details>
                        <summary>
                          {record.provider} · {record.model ?? 'Unknown model'} · {record.status}
                        </summary>
                        <dl>
                          <dt>Task</dt>
                          <dd>{record.taskId ?? 'Unknown'}</dd>
                          <dt>Session</dt>
                          <dd>{record.sessionId ?? 'Unknown'}</dd>
                          <dt>Provider version</dt>
                          <dd>{record.providerVersion}</dd>
                          <dt>Observed</dt>
                          <dd>{new Date(record.observedAt).toLocaleString()}</dd>
                          <dt>Input / output</dt>
                          <dd>
                            {count(record.tokens.input)} / {count(record.tokens.output)}
                          </dd>
                          <dt>Cache read / creation</dt>
                          <dd>
                            {count(record.tokens.cacheRead)} / {count(record.tokens.cacheCreation)}
                          </dd>
                          <dt>Thinking</dt>
                          <dd>{count(record.tokens.thinking)}</dd>
                          <dt>Source</dt>
                          <dd>{record.source}</dd>
                        </dl>
                        {record.unavailableReason && <p>{record.unavailableReason}</p>}
                        {record.estimate && (
                          <p>
                            Public API list-price estimate: ${record.estimate.amount.toFixed(4)}.{' '}
                            {record.estimate.assumptions}
                          </p>
                        )}
                      </details>
                    </li>
                  ))}
              </ul>
            </>
          ) : (
            <p>No usage records yet.</p>
          )}
          {usage.records.length > 100 && (
            <p>Showing the latest 100 records. Export includes all retained records.</p>
          )}
          <div className="memory-controls">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const document = await api('usage/export');
                  delete document.apiVersion;
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }),
                  );
                  const link = window.document.createElement('a');
                  link.href = url;
                  link.download = 'latchkit-usage.json';
                  link.click();
                  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                })
              }
            >
              Export usage
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const document = await api('usage/baselines/export');
                  delete document.apiVersion;
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }),
                  );
                  const link = window.document.createElement('a');
                  link.href = url;
                  link.download = 'latchkit-savings-baselines.json';
                  link.click();
                  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                })
              }
            >
              Export savings baselines
            </Button>
            <Button
              variant="outline"
              disabled={busy || usage.records.length === 0}
              onClick={() => setDeleting(true)}
            >
              Delete usage records
            </Button>
            {deleting && (
              <>
                <p>This deletes the retained usage records for this project.</p>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api('usage', { method: 'DELETE' });
                      setDeleting(false);
                      await refresh();
                    })
                  }
                >
                  Confirm deletion
                </Button>
                <Button variant="outline" onClick={() => setDeleting(false)}>
                  Keep records
                </Button>
              </>
            )}
          </div>
          <BaselinesSection
            baselines={baselines}
            busy={busy}
            reload={refreshBaselines}
            notify={(message) => setNotice(message)}
            action={action}
          />
          <SavingsSection
            baselines={baselines}
            busy={busy}
            notify={(message) => setError(message)}
          />
        </>
      )}
    </section>
  );
}
