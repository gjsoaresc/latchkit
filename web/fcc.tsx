import { ExternalLink, Play, RefreshCw, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';

type FccActive = {
  state: 'running' | 'unverified';
  adminUrl?: string;
};

type FccInspection = {
  tool: { version: string };
  state: 'absent' | 'managed';
  active: FccActive | null;
  lifecycle: { phase: 'building' | 'failed' | 'abandoned' } | null;
};

type FccAction = { action: string; active?: FccActive };

function verifiedAdminUrl(active: FccActive | null): string | null {
  if (active?.state !== 'running' || typeof active.adminUrl !== 'string') return null;
  return /^http:\/\/127\.0\.0\.1:8082\/admin\/?$/.test(active.adminUrl) ? active.adminUrl : null;
}

function statusFor(tool: FccInspection): string {
  if (tool.active?.state === 'running') return 'Running and ready';
  if (tool.active?.state === 'unverified') return 'Needs recovery';
  if (tool.lifecycle && tool.lifecycle.phase !== 'abandoned') return 'Installation needs recovery';
  return tool.state === 'managed' ? 'Ready to start' : 'Not installed';
}

export function FccConsole() {
  const [tool, setTool] = useState<FccInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setTool(await api<FccInspection>('tools/fcc'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to inspect the local tool.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const action = async (name: 'start' | 'stop') => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<FccAction>(`tools/fcc/${name}`, { method: 'POST', body: {} });
      setTool((current) => {
        if (!current) return current;
        return {
          ...current,
          active: name === 'start' ? (result.active ?? current.active) : null,
        };
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to ${name} FCC.`);
    } finally {
      setBusy(false);
    }
  };

  const adminUrl = tool ? verifiedAdminUrl(tool.active) : null;
  const canStart = tool?.state === 'managed' && !tool.active && !tool.lifecycle;
  const canStop = tool?.active?.state === 'running';

  return (
    <section className="config-section fcc-section" aria-labelledby="fcc-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">OPTIONAL LOCAL TOOL</p>
          <h2 id="fcc-heading">Free Claude Code.</h2>
          <p>
            Inspect and control a locally managed FCC server. Setup stays in the documented CLI
            flow.
          </p>
        </div>
        <Button variant="outline" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
      </div>
      <Card className="fcc-card" aria-live="polite">
        {tool ? (
          <>
            <div className="fcc-status">
              <div>
                <span className="mini-label">FCC {tool.tool.version}</span>
                <strong>{statusFor(tool)}</strong>
              </div>
              <span className={`fcc-state ${tool.active?.state === 'running' ? 'is-running' : ''}`}>
                {tool.active?.state === 'running' ? 'READY' : tool.state.toUpperCase()}
              </span>
            </div>
            {tool.state === 'absent' ? (
              <p className="section-note">
                FCC is not installed. Use the CLI installation guide before starting a server.
              </p>
            ) : tool.active?.state === 'unverified' ||
              (tool.lifecycle && tool.lifecycle.phase !== 'abandoned') ? (
              <p className="section-note">
                This installation needs recovery. Run <code>latchkit tool fcc recover</code> from
                the CLI, then refresh this card.
              </p>
            ) : (
              <p className="section-note">
                {tool.active?.state === 'running'
                  ? 'The loopback controller passed its readiness checks.'
                  : 'Start runs the managed loopback controller with its existing local profile.'}
              </p>
            )}
          </>
        ) : (
          <p className="section-note">Inspecting the optional local tool…</p>
        )}
        {error && (
          <p className="fcc-error" role="alert">
            {error}
          </p>
        )}
        <div className="fcc-actions">
          <Button onClick={() => void action('start')} disabled={busy || !canStart}>
            <Play aria-hidden="true" />
            Start server
          </Button>
          <Button variant="outline" onClick={() => void action('stop')} disabled={busy || !canStop}>
            <Square aria-hidden="true" />
            Stop server
          </Button>
          {adminUrl && (
            <Button asChild variant="outline">
              <a href={adminUrl} target="_blank" rel="noreferrer noopener">
                Open Admin <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          )}
          <a
            className="fcc-guide"
            href="https://github.com/willahealm/latchkit/blob/main/docs/managed-fcc.md"
            target="_blank"
            rel="noreferrer noopener"
          >
            CLI installation guide <ExternalLink aria-hidden="true" />
          </a>
        </div>
      </Card>
    </section>
  );
}
