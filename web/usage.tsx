import { useEffect, useState } from 'react';
import type { inspectUsage } from '../src/usage/service.js';
import { api } from './api.js';
import { Button } from './components/ui/button.js';
import { Input, Label } from './components/ui/fields.js';

type Usage = Awaited<ReturnType<typeof inspectUsage>>;
const count = (value: number | null) => (value === null ? 'Unknown' : value.toLocaleString());

export function UsageConsole() {
  const [usage, setUsage] = useState<Usage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retention, setRetention] = useState(30);
  const [deleting, setDeleting] = useState(false);
  async function refresh() {
    const next = await api<Usage>('usage');
    setUsage(next);
    setRetention(next.settings.retentionDays);
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
    void action(refresh);
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
          {usage.records.length ? (
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
        </>
      )}
    </section>
  );
}
