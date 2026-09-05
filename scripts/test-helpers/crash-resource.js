import { withProjectLock } from '../../src/installer/lock.js';
import {
  applyRegisteredTransaction,
  createResourceRegistry,
} from '../../src/installer/transactions.js';

const [root, boundary] = process.argv.slice(2);
const registry = createResourceRegistry([
  { id: 'provider:test-settings', path: '.provider/settings.json' },
]);
const next = '{\n  "userSetting": true,\n  "managedImport": "latchkit"\n}\n';
await withProjectLock(root, () =>
  applyRegisteredTransaction(root, {
    operation: 'provider-fixture',
    registry,
    changes: [{ resourceId: 'provider:test-settings', bytes: next }],
    manifest: '{"state":"after"}\n',
    faultBoundary: async (current) => {
      if (current !== boundary) return;
      process.send?.({ boundary: current });
      await new Promise(() => {});
    },
  }),
);
