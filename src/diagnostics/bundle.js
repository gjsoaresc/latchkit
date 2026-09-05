import { randomUUID } from 'node:crypto';
import { readConfig, doctor, inspectRecovery } from '../core.js';
import { writeAtomic } from '../storage.js';
import { readEvents } from './logger.js';
import { DIAGNOSTICS_SCHEMA_VERSION } from './errors.js';
import { redact, redactPath } from './redact.js';

const BUNDLE_RELATIVE_PREFIX = '.latchkit/diagnostics/support-';

async function buildBundle(root) {
  const config = await readConfig(root);
  const events = await readEvents(root);
  const evidence = await inspectRecovery(root).catch((error) => ({ error: redact(error.message) }));
  return {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    files: ['metadata.json', 'events.ndjson', 'recovery.json'],
    redactions: [
      'credential-like keys and supplied secret values',
      'authorization headers and URL secrets',
      'sensitive path segments',
    ],
    metadata: redact({
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      config: {
        schemaVersion: config.schemaVersion,
        providers: config.providers,
        skills: config.skills,
        packCount: config.packs?.length ?? 0,
      },
      doctor: await doctor(root),
    }),
    events: events.map((event) => redact(event)),
    recovery: redact(evidence),
  };
}

export async function previewSupportBundle(root) {
  const bundle = await buildBundle(root);
  return {
    ...bundle,
    output: null,
    review:
      'Inspect the allowlisted files and redactions before sharing. Latchkit never uploads this bundle.',
  };
}

export async function exportSupportBundle(root) {
  const bundle = await buildBundle(root);
  const filename = `${BUNDLE_RELATIVE_PREFIX}${Date.now()}-${randomUUID()}.json`;
  await writeAtomic(root, filename, `${JSON.stringify(bundle, null, 2)}\n`);
  return {
    output: redactPath(filename),
    files: bundle.files,
    redactions: bundle.redactions,
    review: 'Inspect the exported file before sharing. Latchkit never uploads this bundle.',
  };
}
