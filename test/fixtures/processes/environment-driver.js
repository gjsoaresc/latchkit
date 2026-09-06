import { runProviderProcess } from '../../../dist/src/runtime/process-runner.js';
import { providerById } from '../../../dist/src/providers/registry.js';

const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('ANTHROPIC_')),
);
environment.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9999';
environment.ANTHROPIC_AUTH_TOKEN = 'fixture-proxy-token';
const result = await runProviderProcess({
  provider: providerById('claude'),
  executionProfile: 'host-local-authorized',
  environmentMode: process.argv[2],
  plan: {
    executable: process.execPath,
    ...(process.argv[3] ? { cwd: process.argv[3] } : {}),
    args: [
      '-e',
      `console.log(JSON.stringify({ apiKey: process.env.ANTHROPIC_API_KEY ?? null, headers: process.env.ANTHROPIC_CUSTOM_HEADERS ?? null, token: process.env.ANTHROPIC_AUTH_TOKEN, url: process.env.ANTHROPIC_BASE_URL, fixture: process.env.LATCHKIT_ENV_FIXTURE }))`,
    ],
    environment,
  },
});
if (result.status !== 'exited')
  process.stdout.write(JSON.stringify({ status: result.status, code: result.code }));
else if (result.exitCode !== 0) throw new Error('Environment fixture failed.');
else process.stdout.write(result.stdout);
