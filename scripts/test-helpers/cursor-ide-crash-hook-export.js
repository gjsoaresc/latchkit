import { applyCursorIdeHookExport } from '../../src/providers/cursor-ide.js';

await applyCursorIdeHookExport(process.argv[2], {
  enabled: false,
  faultBoundary: async (boundary) => {
    if (boundary === 'resource:0') process.exit(91);
  },
});
