import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { api } from './api.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';

/**
 * Settings -> Updates (issue #139 slice 2). Manual "Check for updates" and "Install and
 * restart" over the authenticated local API added in src/installation/updates/routes.ts. This
 * section intentionally does not add the manual/notify/automatic preference control or any
 * onboarding surface — that is issue #139 slice 3.
 */

type UpdateMode = 'manual' | 'notify' | 'automatic';
type OwnershipKind =
  'self-managed' | 'package-manager' | 'unowned' | 'source-development' | 'unsupported-platform';

interface Ownership {
  kind: OwnershipKind;
  reason: string;
}

interface ReleaseCandidate {
  version: string;
  tag: string;
  publishedAt: string | null;
  notesUrl: string | null;
  notes: string;
}

interface ReleaseCheckResult {
  checkedAt: string;
  outcome:
    'no-releases' | 'offline' | 'rate-limited' | 'missing-asset' | 'current' | 'update-available';
  candidate: ReleaseCandidate | null;
  majorUpdate: boolean;
  reason: string | null;
}

interface StagedUpdateRecord {
  previewId: string;
  version: string;
  status: 'ready' | 'failed';
  failureReason: string | null;
}

interface UpdateSettings {
  revision: number;
  mode: UpdateMode;
}

interface UpdateStatus {
  installedVersion: string;
  /** Set only when `current` points at a different version than this running process was
   * launched from — for example a CLI `self upgrade`/`update rollback` already flipped it and
   * this console has not restarted yet. */
  activatedVersion: string | null;
  status: string;
  reason: string | null;
  staged: StagedUpdateRecord | null;
  lastCheck: ReleaseCheckResult | null;
}

interface UpdatesData {
  settings: UpdateSettings;
  status: UpdateStatus;
  ownership: Ownership;
}

interface UpdatePreview {
  previewId: string;
  version: string;
  majorUpdate: boolean;
  notes: string;
}

interface HandoffFailure {
  status: 'failed';
  stage: string;
  reason: string;
  recoveryCommand: string | null;
}

type Phase =
  | 'idle'
  | 'checking'
  | 'previewing'
  | 'staging'
  | 'activating'
  | 'restarting'
  | 'blocked'
  | 'failed';

function messageFrom(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export function UpdatesConsole({ hasUnsavedEdits }: { hasUnsavedEdits: boolean }) {
  const [data, setData] = useState<UpdatesData | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<HandoffFailure | null>(null);
  const [confirmMajor, setConfirmMajor] = useState(false);
  const previewRef = useRef<UpdatePreview | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  const refresh = useCallback(async () => {
    try {
      setData(await api<UpdatesData>('updates'));
    } catch (cause) {
      setError(messageFrom(cause, 'Unable to inspect updates.'));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      const current = phaseRef.current;
      if (current === 'idle' || current === 'blocked' || current === 'failed') void refresh();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Report this console's unsaved-edit state so the installation-wide quiescence check (issue
  // #139 slice 2) can defer activation while any console sharing this project has a draft.
  useEffect(() => {
    void api('updates/activity', { method: 'POST', body: { dirty: hasUnsavedEdits } }).catch(() => {
      /* Best-effort signal only; a failed heartbeat ping never blocks the settings page. */
    });
  }, [hasUnsavedEdits]);

  const check = async () => {
    setPhase('checking');
    setError(null);
    setBlockers(null);
    setFailure(null);
    try {
      await api<ReleaseCheckResult>('updates/check', { method: 'POST', body: {} });
      await refresh();
    } catch (cause) {
      setError(messageFrom(cause, 'Unable to check for updates.'));
    } finally {
      setPhase('idle');
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  const installAndRestart = async () => {
    if (!data) return;
    if (data.status.lastCheck?.majorUpdate && !confirmMajor) {
      setConfirmMajor(true);
      return;
    }
    setError(null);
    setBlockers(null);
    setFailure(null);
    try {
      setPhase('previewing');
      const preview = await api<UpdatePreview>('updates/preview', { method: 'POST', body: {} });
      previewRef.current = preview;

      setPhase('staging');
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await api<StagedUpdateRecord>('updates/stage', {
          method: 'POST',
          body: { previewId: preview.previewId },
          signal: controller.signal,
        });
      } catch (cause) {
        if ((cause as { cancelled?: boolean }).cancelled) {
          setPhase('idle');
          return;
        }
        throw cause;
      }
      abortRef.current = null;

      setPhase('activating');
      const result = await api<{ status: string; reconnect?: { url: string } }>(
        'updates/activate',
        {
          method: 'POST',
          body: { expectedRevision: data.settings.revision, updateId: preview.previewId },
        },
      );
      if (result.status === 'completed' && result.reconnect) {
        setPhase('restarting');
        // Reconnect to the verified replacement's real endpoint (a fresh ephemeral port and
        // session token — reloading the old URL would not work), while keeping the console on
        // the same page it was already showing (issue #139: "preserve selected project/page").
        const target = new URL(result.reconnect.url);
        window.location.href = `${target.origin}${window.location.pathname}${target.hash}`;
        return;
      }
      await refresh();
      setPhase('idle');
    } catch (cause) {
      abortRef.current = null;
      const record = cause as
        { status?: number; blockers?: string[]; reasons?: string[] } | undefined;
      if (record?.status === 409 && Array.isArray(record.blockers)) {
        setBlockers(record.blockers);
        setPhase('blocked');
      } else if (record?.status === 409 && Array.isArray(record.reasons)) {
        setBlockers(record.reasons);
        setPhase('blocked');
      } else if (record?.status === 502) {
        setFailure(cause as unknown as HandoffFailure);
        setPhase('failed');
      } else {
        setError(messageFrom(cause, 'Unable to install this update.'));
        setPhase('idle');
      }
    } finally {
      setConfirmMajor(false);
    }
  };

  if (!data)
    return (
      <section className="config-section" aria-labelledby="updates-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">05 / STAY CURRENT</p>
            <h2 id="updates-heading">Updates.</h2>
          </div>
        </div>
        <p className="section-note">{error ?? 'Checking update status…'}</p>
      </section>
    );

  const { settings, status, ownership } = data;
  const candidate = status.lastCheck?.candidate ?? null;
  const canInstall =
    ownership.kind === 'self-managed' &&
    (status.status === 'update-available' || status.staged?.status === 'ready');
  const busy =
    phase === 'checking' || phase === 'previewing' || phase === 'staging' || phase === 'activating';

  return (
    <section className="config-section" aria-labelledby="updates-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">05 / STAY CURRENT</p>
          <h2 id="updates-heading">Updates.</h2>
          <p>Manual checks and installs. Mode: {settings.mode}.</p>
        </div>
        <span className="subtle-tag">v{status.installedVersion}</span>
      </div>
      <Card className="fcc-card" aria-live="polite">
        <div className="fcc-status">
          <div>
            <span className="mini-label">RUNNING VERSION {status.installedVersion}</span>
            <strong>
              {status.status === 'update-available' && candidate
                ? `Update available: ${candidate.version}`
                : status.status === 'current'
                  ? 'You are on the latest compatible release.'
                  : status.status === 'ready'
                    ? `Ready to install ${status.staged?.version}`
                    : status.status === 'failed'
                      ? 'The last update attempt failed.'
                      : 'No update check has been performed yet.'}
            </strong>
            {status.activatedVersion && (
              <p className="section-note">
                Activated version {status.activatedVersion} differs from the running version;
                restart to pick it up.
              </p>
            )}
          </div>
          <span className="fcc-state">{ownership.kind.toUpperCase().replace('-', ' ')}</span>
        </div>
        <p className="section-note">
          Channel: {ownership.kind}. Last check:{' '}
          {status.lastCheck?.checkedAt
            ? new Date(status.lastCheck.checkedAt).toLocaleString()
            : 'never'}{' '}
          (checked at most once every 24 hours, plus explicit checks).
        </p>
        {ownership.kind !== 'self-managed' && <p className="section-note">{ownership.reason}</p>}
        {candidate?.notes && (
          <p className="section-note" style={{ whiteSpace: 'pre-wrap' }}>
            {/* Release notes are untrusted, server-supplied text (issue #139): rendered as
                plain text here, never as interpreted HTML/markdown. */}
            {candidate.notes}
          </p>
        )}
        {status.lastCheck?.majorUpdate && candidate && (
          <p className="section-note" role="alert">
            This is a major-version update and requires manual review before installing.
          </p>
        )}
        {error && (
          <p className="fcc-error" role="alert">
            {error}
          </p>
        )}
        {phase === 'blocked' && blockers && (
          <div className="fcc-error" role="alert">
            <p>Installing is not possible right now:</p>
            <ul>
              {blockers.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
        {phase === 'failed' && failure && (
          <div className="fcc-error" role="alert">
            <p>
              The update failed at the {failure.stage} step: {failure.reason}
            </p>
            {failure.recoveryCommand && (
              <p>
                Recover from the CLI: <code>{failure.recoveryCommand}</code>
              </p>
            )}
          </div>
        )}
        {phase === 'restarting' && <p className="section-note">Restarting and reconnecting…</p>}
        <div className="fcc-actions">
          <Button
            variant="outline"
            onClick={() => void check()}
            disabled={busy || ownership.kind !== 'self-managed'}
          >
            <RefreshCw aria-hidden="true" />
            Check for updates
          </Button>
          {canInstall && (
            <Button onClick={() => void installAndRestart()} disabled={busy || hasUnsavedEdits}>
              <Download aria-hidden="true" />
              {confirmMajor ? 'Confirm install (major update)' : 'Install and restart'}
            </Button>
          )}
          {phase === 'staging' && (
            <Button variant="outline" onClick={cancel}>
              Cancel
            </Button>
          )}
        </div>
        {hasUnsavedEdits && canInstall && (
          <p className="section-note">
            Save or discard your unsaved changes before installing an update.
          </p>
        )}
      </Card>
    </section>
  );
}
