/**
 * Authenticated local API routes for the console updater (issue #139 slice
 * 2, acceptance criteria 1 and 7).
 *
 * `src/server.ts` already enforces the bearer-token and same-origin checks
 * shared by every `/api/*` route before dispatching here — see its
 * `authenticated`/origin checks — and the generic restart admission barrier
 * (`isRestartAdmissionBlocked` below, also consumed from `server.ts`) before
 * any mutating route (including these) is allowed to run. This module never
 * accepts an installation root, URL, or shell command from request input:
 * `installRoot` and `ownership` are resolved once, at server start, only
 * from this process's own environment (see `ownership.ts`'s documented
 * contract) and closed over here.
 *
 * Every mutating route binds to the server's own verified installation
 * identity and an explicit expected revision/update ID, rejecting a stale
 * or duplicate-with-different-payload request rather than silently
 * reinterpreting it. A preview is never trusted back from the client: the
 * exact `UpdatePreview` this module returns from `/preview` is cached
 * in-memory, keyed by its own `previewId`, and `/stage` only ever looks
 * that cached copy up — a client can never point staging at an arbitrary
 * URL by resubmitting a forged preview body.
 */
import http from 'node:http';
import { VERSION } from '../../version.js';
import { inspectInstallation } from '../manager.js';
import { parseActivationKey } from '../onboarding.js';
import type { InstallationOwnershipResult } from './ownership.js';
import {
  activateStagedUpdate,
  checkForUpdates,
  DownloadCancelledError,
  inspectUpdateSettings,
  inspectUpdateStatus,
  previewUpdate,
  rollbackUpdate,
  stageUpdate,
} from './service.js';
import type { UpdatePreview } from './contracts.js';
import {
  isInstallationLeaseActive,
  readInstallationLease,
  readStagedUpdateRecord,
  readUpdateHandoffRecord,
} from './store.js';
import { performActivationHandoff, stagedVersionDirectory } from './handoff.js';
import type { HeartbeatHandle } from './activity.js';

/** Mutating `/api/updates/*` routes that must remain reachable even while a
 * restart lease is active: `/activate` and `/rollback` manage the lease
 * themselves (see `workload.ts`'s `acquireRestartLease`), and `/activity`
 * is bounded, non-authoritative UI signal traffic explicitly exempted from
 * workload-idle counting by acceptance criterion 5. Every other mutating
 * route in the app (config save, sync, task/workflow mutations, ...) is
 * blocked while a lease is active. */
export const EXEMPT_DURING_RESTART = new Set([
  '/api/updates/activate',
  '/api/updates/rollback',
  '/api/updates/activity',
]);

/** The generic restart admission barrier (acceptance criterion 5):
 * `src/server.ts` calls this once, for every non-GET/HEAD `/api/*` request,
 * before its own dispatch chain. Returns a human-readable reason when the
 * request must be rejected, or `null` when it may proceed. Cheap: a single
 * small JSON file read, and `null` immediately when no lease file exists. */
export async function isRestartAdmissionBlocked(
  pathname: string,
  method: string,
  installRoot: string,
): Promise<string | null> {
  if (method === 'GET' || method === 'HEAD') return null;
  if (EXEMPT_DURING_RESTART.has(pathname)) return null;
  const lease = await readInstallationLease(installRoot).catch(() => null);
  if (lease && isInstallationLeaseActive(lease))
    return 'Latchkit is applying an update and will restart shortly. Try again once it reconnects.';
  return null;
}

export interface UpdateRoutesContext {
  installRoot: string;
  ownership: InstallationOwnershipResult;
  projectRoot: string;
  projectsRegistryRoot: string;
  serverId: string;
  heartbeat: HeartbeatHandle;
  /** Current count of admitted, non-exempt mutating requests on *this*
   * server (see the mutating-request counter `server.ts` maintains). */
  getMutatingCount: () => number;
  /** Called once, after a successful activation response has been sent to
   * the browser, to drain and close this (now superseded) server. */
  onHandoffSucceeded: () => void;
  fail: (status: number, message: string) => Error & { status: number };
  respond: (res: http.ServerResponse, status: number, value: object) => void;
  readJson: <T = Record<string, unknown>>(req: http.IncomingMessage) => Promise<T>;
  spawnImpl?: Parameters<typeof performActivationHandoff>[0]['spawnImpl'];
  fetchImpl?: Parameters<typeof performActivationHandoff>[0]['fetchImpl'];
  readyTimeoutMs?: number;
  extraEnv?: Record<string, string>;
  clock?: () => Date;
}

interface CachedPreview {
  preview: UpdatePreview;
  expiresAt: number;
}

const PREVIEW_TTL_MS = 10 * 60 * 1000;

function ownershipLimitation(ownership: InstallationOwnershipResult): string {
  return ownership.reason;
}

export function createUpdateRoutes(context: UpdateRoutesContext) {
  const previews = new Map<string, CachedPreview>();
  const cachePreview = (preview: UpdatePreview) => {
    previews.set(preview.previewId, { preview, expiresAt: Date.now() + PREVIEW_TTL_MS });
  };
  const takeValidPreview = (previewId: unknown): UpdatePreview | null => {
    if (typeof previewId !== 'string' || !previewId) return null;
    const cached = previews.get(previewId);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
      previews.delete(previewId);
      return null;
    }
    return cached.preview;
  };

  async function requireSelfManaged(): Promise<void> {
    if (context.ownership.kind !== 'self-managed')
      throw context.fail(409, ownershipLimitation(context.ownership));
  }

  return {
    /** Returns true when the request was handled (whether it succeeded or
     * failed with a thrown, caller-caught error) so `server.ts` knows not
     * to fall through to its own dispatch/404. */
    async handle(
      req: http.IncomingMessage,
      res: http.ServerResponse,
      requestUrl: URL,
    ): Promise<boolean> {
      const pathname = requestUrl.pathname;
      if (pathname === '/api/updates' && req.method === 'GET') {
        const [settings, status] = await Promise.all([
          inspectUpdateSettings(context.installRoot),
          inspectUpdateStatus(context.installRoot),
        ]);
        // "Activated version if different" (issue #139): `current` can point at a version other
        // than the one this running process was launched from — for example a CLI `self
        // upgrade`/`update rollback` flipped it while this server has not yet been restarted.
        // Only meaningful for a self-managed installation that actually has an installation
        // root to inspect; never derived from request input.
        let activatedVersion: string | null = null;
        if (context.ownership.kind === 'self-managed' && context.ownership.root) {
          const inspection = await inspectInstallation(context.ownership.root).catch(() => null);
          const parsed = inspection?.active ? parseActivationKey(inspection.active) : null;
          if (parsed && parsed.version !== status.installedVersion)
            activatedVersion = parsed.version;
        }
        context.respond(res, 200, {
          settings,
          status: { ...status, activatedVersion },
          ownership: context.ownership,
        });
        return true;
      }
      if (pathname === '/api/updates/recovery' && req.method === 'GET') {
        context.respond(res, 200, { record: await readUpdateHandoffRecord(context.installRoot) });
        return true;
      }
      if (pathname === '/api/updates/activity' && req.method === 'POST') {
        const body = await context.readJson<{ dirty?: boolean }>(req);
        context.heartbeat.setDirty(body.dirty === true);
        context.respond(res, 200, { ok: true });
        return true;
      }
      if (pathname === '/api/updates/check' && req.method === 'POST') {
        await requireSelfManaged();
        context.respond(res, 200, await checkForUpdates(context.installRoot));
        return true;
      }
      if (pathname === '/api/updates/preview' && req.method === 'POST') {
        await requireSelfManaged();
        const preview = await previewUpdate(context.installRoot);
        cachePreview(preview);
        context.respond(res, 200, preview);
        return true;
      }
      if (pathname === '/api/updates/stage' && req.method === 'POST') {
        await requireSelfManaged();
        const body = await context.readJson<{ previewId?: string }>(req);
        const preview = takeValidPreview(body.previewId);
        if (!preview)
          throw context.fail(
            409,
            'This preview has expired or is unknown. Request a new preview before staging.',
          );
        const controller = new AbortController();
        let responded = false;
        const onClose = () => {
          if (!responded) controller.abort();
        };
        req.on('close', onClose);
        try {
          const staged = await stageUpdate(context.installRoot, preview, {
            signal: controller.signal,
          });
          context.respond(res, 200, staged);
        } catch (error) {
          if (error instanceof DownloadCancelledError) {
            throw context.fail(400, 'The download was cancelled.');
          }
          throw error;
        } finally {
          responded = true;
          req.off('close', onClose);
        }
        return true;
      }
      if (pathname === '/api/updates/activate' && req.method === 'POST') {
        await requireSelfManaged();
        const body = await context.readJson<{ expectedRevision?: number; updateId?: string }>(req);
        const settings = await inspectUpdateSettings(context.installRoot);
        if (body.expectedRevision !== settings.revision)
          throw context.fail(
            428,
            'Settings changed since this update was checked. Refresh and retry.',
          );
        const staged = await readStagedUpdateRecord(context.installRoot);
        if (!staged || staged.status !== 'ready' || staged.previewId !== body.updateId)
          throw context.fail(
            409,
            'No matching staged update is ready to activate. Request a fresh preview and stage it again.',
          );
        const result = await performActivationHandoff({
          installRoot: context.installRoot,
          projectsRegistryRoot: context.projectsRegistryRoot,
          projectRoot: context.projectRoot,
          ownServerId: context.serverId,
          ownMutating: context.getMutatingCount(),
          ownDirty: context.heartbeat.isDirty(),
          fromVersion: VERSION,
          toVersion: staged.version,
          target: staged.target,
          stagedDirectory: staged.directory,
          activate: () => activateStagedUpdate(context.installRoot, { target: staged.target }),
          spawnImpl: context.spawnImpl,
          fetchImpl: context.fetchImpl,
          readyTimeoutMs: context.readyTimeoutMs,
          extraEnv: context.extraEnv,
          clock: context.clock,
        });
        await respondToHandoffResult(context, res, result);
        return true;
      }
      if (pathname === '/api/updates/rollback' && req.method === 'POST') {
        await requireSelfManaged();
        const body = await context.readJson<{
          version?: string;
          target?: string;
          expectedRevision?: number;
        }>(req);
        const settings = await inspectUpdateSettings(context.installRoot);
        if (body.expectedRevision !== settings.revision)
          throw context.fail(
            428,
            'Settings changed since this action was requested. Refresh and retry.',
          );
        if (typeof body.version !== 'string' || !body.version)
          throw context.fail(400, 'A target version is required.');
        const target =
          typeof body.target === 'string' && body.target ? body.target : context.ownership.target;
        const result = await performActivationHandoff({
          installRoot: context.installRoot,
          projectsRegistryRoot: context.projectsRegistryRoot,
          projectRoot: context.projectRoot,
          ownServerId: context.serverId,
          ownMutating: context.getMutatingCount(),
          ownDirty: context.heartbeat.isDirty(),
          fromVersion: VERSION,
          toVersion: body.version,
          target,
          stagedDirectory: stagedVersionDirectory(context.installRoot, body.version, target),
          activate: () => rollbackUpdate(context.installRoot, body.version!, target),
          spawnImpl: context.spawnImpl,
          fetchImpl: context.fetchImpl,
          readyTimeoutMs: context.readyTimeoutMs,
          extraEnv: context.extraEnv,
          clock: context.clock,
        });
        await respondToHandoffResult(context, res, result);
        return true;
      }
      return false;
    },
  };
}

async function respondToHandoffResult(
  context: UpdateRoutesContext,
  res: http.ServerResponse,
  result: Awaited<ReturnType<typeof performActivationHandoff>>,
): Promise<void> {
  if (result.outcome === 'blocked-preflight') {
    context.respond(res, 409, {
      status: 'blocked',
      reasonKind: 'incompatible-pending-work',
      blockers: result.blockers,
    });
    return;
  }
  if (result.outcome === 'blocked-quiescence') {
    context.respond(res, 409, { status: 'waiting', reasons: result.reasons });
    return;
  }
  if (result.outcome === 'failed') {
    // `performActivationHandoff` already persisted the exact recovery
    // command alongside the rest of this attempt's evidence; read it back
    // rather than reconstructing a second, possibly-diverging copy here.
    const record = await readUpdateHandoffRecord(context.installRoot).catch(() => null);
    context.respond(res, 502, {
      status: 'failed',
      stage: result.stage,
      reason: result.reason,
      recoveryCommand: record?.recoveryCommand ?? null,
    });
    return;
  }
  context.respond(res, 200, {
    status: 'completed',
    reconnect: { url: result.replacement.url },
  });
  // The response above must reach the browser before this server begins
  // draining and closing itself (acceptance criterion 5: "acknowledge that
  // request before old-server drain").
  setImmediate(() => context.onHandoffSucceeded());
}
