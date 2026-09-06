export interface Selection {
  providers: string[];
  skills: string[];
  [key: string]: unknown;
}
export interface ConsoleState {
  config: Selection;
  configRevision: string;
  providers: { id: string; label: string; skillDirectory: string }[];
  skills: { id: string; label: string; description: string }[];
  doctor: {
    project: string;
    platform: string;
    runtime: string;
    node: string;
    providers: { id: string; detected: boolean; path?: string }[];
  };
}
export interface SyncPreview {
  changes: { action: string; path: string }[];
  conflicts: { path: string; reason: string }[];
  planId: string;
}
export interface Source {
  revision: string | null;
  dirtyFingerprint: string | null;
}
export interface Evidence {
  id: string;
  criterionId: string;
  criterionRevision: number;
  artifact: string | null;
  outcome: string;
  source: Source;
}
export interface ConsoleTask {
  id: string;
  title: string;
  state: string;
  revision: number;
  criteria: { id: string; revision: number; description: string }[];
  evidence: Evidence[];
  checkpoints: { summary: string }[];
  reconciliation?: { currentSource: Source; recordedProcess: string };
}
export interface MemoryPage {
  revision: number;
  query: string;
  memories: {
    memory: { id: string; title: string; text: string; kind: string; revision: number };
    score: number | null;
  }[];
}
export interface Workbench {
  tasks: { revision: number; tasks: ConsoleTask[] };
  memory: MemoryPage;
}
export interface Annotations {
  revision: number;
  currentRevision: string;
  annotations: {
    id: string;
    path: string;
    line: number;
    side: string;
    body: string;
    stale: boolean;
    status: string;
  }[];
}
export interface RecoveryContext {
  context?: string;
  reason: string;
  mode: string;
}
export interface ApiError extends Error {
  status?: number;
  code?: string;
}
export function apiError(error: unknown): ApiError {
  if (error instanceof Error) return error;
  return new Error(String(error));
}
