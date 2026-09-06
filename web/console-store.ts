import { api, hasSession } from './api.js';
import {
  apiError,
  type ConsoleState,
  type Selection,
  type SyncPreview,
  type Workbench,
  type MemoryPage,
} from './types.js';

interface Snapshot {
  state?: ConsoleState;
  selection: Selection;
  busy: boolean;
  plan?: SyncPreview;
  changed: boolean;
  workbench?: Workbench;
  memory?: MemoryPage;
  workbenchStatus: string;
  connection: string;
  notice?: { message: string; error: boolean };
}
function comparable(config: Selection) {
  return JSON.stringify({
    ...config,
    providers: [...new Set(config.providers)].sort(),
    skills: [...new Set(config.skills)].sort(),
  });
}

export function createConsoleStore() {
  let snapshot: Snapshot = {
    selection: { providers: [], skills: [] },
    busy: true,
    changed: false,
    workbenchStatus: 'Loading task state…',
    connection: 'Loading workspace…',
  };
  const listeners = new Set<() => void>();
  let refreshing: Promise<void> | undefined;
  let workbenchGeneration = 0;
  const update = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const notice = (message: string, error = false) => update({ notice: { message, error } });
  const dirty = () =>
    snapshot.state !== undefined &&
    comparable(snapshot.selection) !== comparable(snapshot.state.config);
  async function reloadWorkbench() {
    const generation = ++workbenchGeneration;
    const workbench = await api<Workbench>('workbench');
    if (generation !== workbenchGeneration) return;
    update({
      workbench,
      memory: workbench.memory,
      workbenchStatus: `Authoritative local state: task revision ${workbench.tasks?.revision ?? 0}, memory revision ${workbench.memory?.revision ?? 0}.`,
    });
  }
  async function reloadState(preserveSelection?: Selection) {
    const state = await api<ConsoleState>('state');
    update({
      state,
      selection: preserveSelection
        ? {
            ...state.config,
            providers: preserveSelection.providers,
            skills: preserveSelection.skills,
          }
        : state.config,
    });
    await reloadWorkbench();
  }
  async function action(operation: () => Promise<void>): Promise<boolean> {
    if (snapshot.busy) return false;
    // Fence any older background response before a user mutation.
    workbenchGeneration++;
    update({ busy: true });
    try {
      await operation();
      return true;
    } catch (caught) {
      const error = apiError(caught);
      if (error.code === 'CONFIG_REVISION_CONFLICT' || error.code === 'SYNC_PLAN_STALE') {
        const pending = snapshot.selection;
        update({ plan: undefined, changed: true });
        try {
          await reloadState(pending);
          notice(
            'Workspace changed elsewhere. Your edits were kept. Review them, save again, and create a new preview.',
            true,
          );
        } catch (refreshError) {
          notice(
            `Your edits were kept, but the latest workspace could not be loaded. ${apiError(refreshError).message}`,
            true,
          );
        }
      } else notice(error.message, true);
      return false;
    } finally {
      update({ busy: false });
    }
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    dirty,
    notice,
    action,
    reloadWorkbench,
    select(kind: 'providers' | 'skills', id: string, checked: boolean) {
      if (snapshot.busy) return;
      const values = snapshot.selection[kind];
      update({
        selection: {
          ...snapshot.selection,
          [kind]: checked ? [...values, id] : values.filter((value) => value !== id),
        },
        plan: undefined,
        changed: true,
      });
    },
    save: () =>
      action(async () => {
        const data = await api<{ config: Selection; configRevision: string }>('config', {
          method: 'PUT',
          body: snapshot.selection,
          revision: snapshot.state?.configRevision,
        });
        if (snapshot.state)
          update({
            state: { ...snapshot.state, ...data },
            selection: data.config,
            plan: undefined,
          });
        notice(
          data.config.providers.length && data.config.skills.length
            ? 'Configuration saved. Preview your sync to review the generated files.'
            : 'Configuration saved with an empty selection. Preview will remove managed skills.',
        );
      }),
    preview: () =>
      action(async () => {
        const plan = await api<SyncPreview>('plan');
        update({ plan, changed: false });
        notice(
          plan.conflicts.length
            ? 'Sync preview found conflicts. Review the details below.'
            : 'Sync preview is ready. Review the file changes below.',
          plan.conflicts.length > 0,
        );
      }),
    apply: () =>
      action(async () => {
        if (!snapshot.plan || dirty()) return;
        await api('sync', { method: 'POST', body: { planId: snapshot.plan.planId } });
        update({ plan: undefined });
        update({ plan: await api<SyncPreview>('plan'), changed: false });
        notice('Skills synced. Reload skills or restart your coding agent to pick up the changes.');
      }),
    search: (query: string) =>
      action(async () => {
        update({
          memory: await api<MemoryPage>(`memory?query=${encodeURIComponent(query.trim())}`),
        });
      }),
    async initialize() {
      if (!hasSession()) {
        update({ busy: false, connection: 'Session key required' });
        notice(
          'Open the complete session URL printed by Latchkit to connect this dashboard.',
          true,
        );
        return;
      }
      try {
        await reloadState();
      } catch (error) {
        notice(apiError(error).message, true);
        update({ connection: 'Unable to connect' });
      } finally {
        update({ busy: false });
      }
    },
    poll() {
      if (!hasSession() || snapshot.busy || document.hidden || refreshing) return;
      // Do not replace a search result during background refresh.
      const query = snapshot.memory?.query;
      refreshing = (async () => {
        const priorMemory = snapshot.memory;
        await reloadWorkbench();
        if (query && snapshot.memory?.query === '') update({ memory: priorMemory });
      })()
        .catch(() =>
          update({
            workbenchStatus:
              'Local state refresh is unavailable; the displayed state may be stale.',
          }),
        )
        .finally(() => {
          refreshing = undefined;
        });
    },
  };
}
export type ConsoleStore = ReturnType<typeof createConsoleStore>;
