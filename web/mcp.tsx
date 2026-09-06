import { useEffect, useState } from 'react';
import { api, hasSession } from './api.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Label, Textarea } from './components/ui/fields.js';
import { Shell, Topbar } from './shell.js';

type Plan = {
  changes: { action: string; path: string }[];
  definitions: unknown[];
  diagnostics: { code: string; provider: string; message: string }[];
  implications: string[];
  missingEnvironment: string[];
};
type Inspection = {
  integrations: Array<{ id: string; configured: boolean; enabled: boolean; authorized: boolean }>;
};

const SAMPLE = JSON.stringify(
  {
    schemaVersion: 1,
    id: 'local-fixture',
    transport: 'http',
    endpoint: 'http://127.0.0.1:8765/mcp',
    providers: ['claude'],
    scope: 'project',
    requiredEnvironment: [],
    enabled: false,
  },
  null,
  2,
);

export function McpConsole() {
  const [source, setSource] = useState(SAMPLE);
  const [inspection, setInspection] = useState<Inspection>();
  const [preview, setPreview] = useState<{ previewId: string; plan: Plan }>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [healthId, setHealthId] = useState('');
  const [health, setHealth] = useState<unknown>();
  const reload = async () => setInspection(await api<Inspection>('mcp'));
  useEffect(() => {
    void reload().catch((error: unknown) =>
      setNotice(error instanceof Error ? error.message : 'MCP inspection failed.'),
    );
  }, []);
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setNotice('');
    try {
      await run();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'MCP action failed.');
    } finally {
      setBusy(false);
    }
  }
  const definitions = () => {
    const value: unknown = JSON.parse(source);
    return Array.isArray(value) ? value : [value];
  };
  if (!hasSession())
    return (
      <Shell
        active="settings"
        tagline={
          <>
            Optional integrations,
            <br />
            explicitly controlled.
          </>
        }
      >
        <Topbar breadcrumb="SETTINGS" breadcrumbHref="/settings" label="MCP" />
        <div className="notice notice-error" role="alert">
          Open the complete session URL printed by Latchkit to connect this dashboard.
        </div>
      </Shell>
    );
  return (
    <Shell
      active="settings"
      tagline={
        <>
          Optional integrations,
          <br />
          explicitly controlled.
        </>
      }
    >
      <Topbar breadcrumb="SETTINGS" breadcrumbHref="/settings" label="MCP" />
      <section className="intro intro-compact">
        <div>
          <p className="eyebrow">OPTIONAL MANAGED MCP</p>
          <h1>Review before enabling.</h1>
          <p className="intro-copy">
            Definitions are inert until you review and explicitly activate the exact configuration.
            This console never starts servers or grants provider permissions.
          </p>
        </div>
      </section>
      {notice && (
        <p className="notice notice-error" role="alert">
          {notice}
        </p>
      )}
      <section className="config-section" aria-labelledby="mcp-definition">
        <div className="section-heading">
          <div>
            <p className="eyebrow">DEFINITION</p>
            <h2 id="mcp-definition">Configuration preview</h2>
          </div>
        </div>
        <Label>
          Managed MCP JSON
          <Textarea
            aria-label="Managed MCP JSON"
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setPreview(undefined);
            }}
            disabled={busy}
          />
        </Label>
        <p className="section-note">
          Preview validates the definition and displays implications only. It does not contact
          endpoints, spawn programs, or write files.
        </p>
        <Button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const result = await api<{ previewId: string; plan: Plan }>('mcp/preview', {
                method: 'POST',
                body: { definitions: definitions(), reviewActivation: true },
              });
              setPreview(result);
            })
          }
        >
          Review exact changes
        </Button>
      </section>
      {preview && (
        <section className="config-section" aria-labelledby="mcp-review">
          <div className="section-heading">
            <div>
              <p className="eyebrow">REVIEWED PREVIEW</p>
              <h2 id="mcp-review">{preview.plan.changes.length} file change(s)</h2>
            </div>
          </div>
          <ul className="plan-changes">
            {preview.plan.changes.map((change) => (
              <li key={`${change.action}:${change.path}`} className="plan-row">
                <span className={`change-action action-${change.action}`}>{change.action}</span>
                <code>{change.path}</code>
              </li>
            ))}
          </ul>
          {preview.plan.diagnostics.map((item) => (
            <p className="notice notice-error" role="alert" key={`${item.code}:${item.provider}`}>
              {item.code}: {item.message}
            </p>
          ))}
          {preview.plan.implications.map((item) => (
            <p className="section-note" key={item}>
              {item}
            </p>
          ))}
          {preview.plan.missingEnvironment.length > 0 && (
            <p className="notice notice-error">
              Missing environment names: {preview.plan.missingEnvironment.join(', ')}
            </p>
          )}
          <Button
            disabled={busy || preview.plan.diagnostics.length > 0}
            onClick={() =>
              void action(async () => {
                await api('mcp/apply', {
                  method: 'POST',
                  body: {
                    definitions: definitions(),
                    previewId: preview.previewId,
                    authorized: true,
                  },
                });
                setNotice('Reviewed MCP configuration applied.');
                setPreview(undefined);
                await reload();
              })
            }
          >
            Explicitly activate reviewed definition
          </Button>
        </section>
      )}
      <section className="config-section" aria-labelledby="mcp-current">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CURRENT STATE</p>
            <h2 id="mcp-current">Managed integrations</h2>
          </div>
          <Button variant="outline" disabled={busy} onClick={() => void action(reload)}>
            Refresh
          </Button>
        </div>
        {inspection?.integrations.length ? (
          <ul className="task-list">
            {inspection.integrations.map((item) => (
              <li className="task-card" key={item.id}>
                <strong>{item.id}</strong>
                <p>
                  Configured: {String(item.configured)} · unchanged/enabled: {String(item.enabled)}{' '}
                  · authorized: {String(item.authorized)}
                </p>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      setHealth(await api('mcp/health', { method: 'POST', body: { id: item.id } }));
                      setHealthId(item.id);
                    })
                  }
                >
                  Run bounded health check
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p>No managed MCP definitions are active.</p>
        )}
        {health !== undefined ? (
          <Card className="plan-panel">
            <p>
              Health for <strong>{healthId}</strong>
            </p>
            <pre>{JSON.stringify(health, null, 2) ?? ''}</pre>
          </Card>
        ) : null}
        <div className="memory-controls">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await api('mcp/remove', { method: 'POST', body: {} });
                setNotice(
                  'Managed MCP entries removed; unrelated provider configuration was retained.',
                );
                await reload();
              })
            }
          >
            Remove managed entries
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await api('mcp/recovery', { method: 'POST', body: {} });
                setNotice('Managed MCP recovery completed.');
                await reload();
              })
            }
          >
            Recover interrupted change
          </Button>
        </div>
      </section>
    </Shell>
  );
}
