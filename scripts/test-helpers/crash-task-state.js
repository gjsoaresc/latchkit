import { checkpointTask } from '../../dist/src/task-state/service.js';

const [root, taskId, runId, expectedRevision, mutationId, requestedBoundary] =
  process.argv.slice(2);

await checkpointTask(
  root,
  {
    taskId,
    runId,
    expectedRevision: Number(expectedRevision),
    mutationId,
    summary: `checkpoint at ${requestedBoundary}`,
  },
  {
    faultBoundary: async (boundary) => {
      if (boundary !== requestedBoundary) return;
      process.send?.({ boundary });
      await new Promise(() => {});
    },
  },
);
