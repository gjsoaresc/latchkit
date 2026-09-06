import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readOptional, writeAtomic } from '../storage.js';
import { withTaskStateLock } from '../task-state/lock.js';

export const REVIEW_ADMISSION_SCHEMA_VERSION = 1;
export const REVIEW_ADMISSION_PATH = '.latchkit/reviews/admission-v1.json';
export const DEFAULT_REVIEW_CONCURRENCY = 2;
export const MAX_REVIEW_ASSIGNMENTS = 4;

type Reservation = {
  id: string;
  reviewId: string;
  assignmentId: string;
  parentTaskId: string;
  controllerId: string;
  pid: number;
  hostname: string;
  reservedAt: string;
};
type ParentRunCount = { parentRunId: string; admittedAssignments: number };
type AdmissionState = {
  schemaVersion: 1;
  reservations: Reservation[];
  parentRuns: ParentRunCount[];
};

const deadOwner = (reservation: Reservation) => {
  if (reservation.hostname !== os.hostname() || !Number.isInteger(reservation.pid)) return false;
  try {
    process.kill(reservation.pid, 0);
    return false;
  } catch (error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
  }
};

async function readState(root: string): Promise<AdmissionState> {
  const raw = await readOptional(root, REVIEW_ADMISSION_PATH);
  if (raw === null) return { schemaVersion: 1, reservations: [], parentRuns: [] };
  try {
    const value = JSON.parse(raw) as AdmissionState;
    if (value.schemaVersion !== 1 || !Array.isArray(value.reservations)) throw new Error();
    return { ...value, parentRuns: Array.isArray(value.parentRuns) ? value.parentRuns : [] };
  } catch {
    throw new Error('Review admission state is invalid.', { cause: 'REVIEW_ADMISSION_INVALID' });
  }
}

async function save(root: string, state: AdmissionState) {
  await writeAtomic(root, REVIEW_ADMISSION_PATH, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export type ReviewReservation = { id: string; release: () => Promise<void> };

/** Atomically reserves one provider invocation. The ledger is shared by every
 * controller for a project, so concurrent CLI/API submissions cannot oversubscribe
 * the default worker admission limit. */
export async function reserveReviewInvocation({
  root,
  reviewId,
  assignmentId,
  parentTaskId,
  controllerId,
  limit = DEFAULT_REVIEW_CONCURRENCY,
  maxAssignments = MAX_REVIEW_ASSIGNMENTS,
  signal,
  clock = () => new Date(),
}: {
  root: string;
  reviewId: string;
  assignmentId: string;
  parentTaskId: string;
  controllerId: string;
  limit?: number;
  maxAssignments?: number;
  signal?: AbortSignal;
  clock?: () => Date;
}): Promise<ReviewReservation> {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    !Number.isInteger(maxAssignments) ||
    maxAssignments < 1
  )
    throw new Error('Review admission limit is invalid.');
  const id = `reservation_${randomUUID()}`;
  while (true) {
    if (signal?.aborted) throw new Error('Review was cancelled before admission.');
    const admitted = await withTaskStateLock(root, async () => {
      const state = await readState(root);
      const live = state.reservations.filter((item) => !deadOwner(item));
      const parent = state.parentRuns.find((item) => item.parentRunId === parentTaskId);
      if ((parent?.admittedAssignments ?? 0) >= maxAssignments)
        throw new Error('Review parent run assignment limit was reached.');
      if (live.length >= limit) {
        if (live.length !== state.reservations.length)
          await save(root, { schemaVersion: 1, reservations: live, parentRuns: state.parentRuns });
        return false;
      }
      live.push({
        id,
        reviewId,
        assignmentId,
        parentTaskId,
        controllerId,
        pid: process.pid,
        hostname: os.hostname(),
        reservedAt: clock().toISOString(),
      });
      if (parent) parent.admittedAssignments += 1;
      else state.parentRuns.push({ parentRunId: parentTaskId, admittedAssignments: 1 });
      await save(root, { schemaVersion: 1, reservations: live, parentRuns: state.parentRuns });
      return true;
    });
    if (admitted) {
      return {
        id,
        release: async () => {
          await withTaskStateLock(root, async () => {
            const state = await readState(root);
            await save(root, {
              schemaVersion: 1,
              reservations: state.reservations.filter((item) => item.id !== id),
              parentRuns: state.parentRuns,
            });
          });
        },
      };
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 25);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

export async function inspectReviewAdmission(root: string): Promise<AdmissionState> {
  const state = await readState(root);
  return { ...state, reservations: state.reservations.filter((item) => !deadOwner(item)) };
}
