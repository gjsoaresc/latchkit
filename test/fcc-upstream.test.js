import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FCC,
  FCC_START_ENVIRONMENT,
  recoverFcc,
  runWithFccClaudeEnvironment,
  validateFccArchive,
} from '../dist/src/managed-tools/fcc.js';
import {
  localRequest,
  runBounded,
  systemEnvironment,
} from '../dist/src/managed-tools/fcc-process.js';
import {
  applyRegisteredTransaction,
  createResourceRegistry,
} from '../dist/src/installer/transactions.js';
import { runProviderProcess } from '../dist/src/runtime/process-runner.js';
import { providerById } from '../dist/src/providers/registry.js';

test(
  'optional pinned archive validates all source members',
  { skip: !process.env.FCC_TEST_ARCHIVE },
  async () => {
    const result = validateFccArchive(await readFile(process.env.FCC_TEST_ARCHIVE));
    assert.ok(result.members.includes('uv.lock'));
    assert.ok(result.members.includes('LICENSE'));
    assert.ok(result.members.includes('src/free_claude_code/config/settings.py'));
  },
);

test(
  'optional live FCC serves every Admin asset and supplies only invocation-scoped Claude credentials',
  { skip: !process.env.FCC_TEST_ROOT || process.env.FCC_TEST_LIVE !== '1' },
  async () => {
    for (const name of [
      'admin.css',
      'admin.js',
      'app-icon.svg',
      'chat_sessions.css',
      'chat_sessions.js',
      'model_combobox.js',
    ]) {
      const response = await localRequest(
        8082,
        `/admin/assets/${FCC.version}/${name}`,
        'GET',
        {},
        2000,
        512_000,
      );
      assert.equal(response.status, 200);
      assert.ok(response.body.length > 0);
    }
    const previousKey = process.env.ANTHROPIC_API_KEY;
    const previousSentinel = process.env.FCC_TEST_PERMISSION_SENTINEL;
    process.env.ANTHROPIC_API_KEY = 'fixture-conflicting-key';
    process.env.FCC_TEST_PERMISSION_SENTINEL = 'preserved';
    try {
      const result = await runWithFccClaudeEnvironment(
        { root: process.env.FCC_TEST_ROOT },
        async ({ environment, environmentMode }) => {
          assert.equal(environmentMode, 'replace');
          assert.equal(environment.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8082');
          assert.ok(environment.ANTHROPIC_AUTH_TOKEN.length >= 32);
          assert.equal(environment.ANTHROPIC_API_KEY, undefined);
          assert.equal(environment.FCC_TEST_PERMISSION_SENTINEL, 'preserved');
          assert.ok(environment.NO_PROXY.split(',').includes('127.0.0.1'));
          assert.equal(environment.NO_PROXY, environment.no_proxy);
          const child = await runProviderProcess({
            provider: providerById('claude'),
            executionProfile: 'host-local-authorized',
            environmentMode,
            timeoutMs: 5000,
            outputLimitBytes: 4096,
            plan: {
              executable: process.execPath,
              args: [
                '-e',
                'console.log(JSON.stringify({ inherited: Boolean(process.env.ANTHROPIC_API_KEY), proxy: Boolean(process.env.ANTHROPIC_AUTH_TOKEN), preserved: process.env.FCC_TEST_PERMISSION_SENTINEL === "preserved" }))',
              ],
              environment,
            },
          });
          assert.equal(child.status, 'exited');
          assert.equal(child.exitCode, 0);
          assert.deepEqual(JSON.parse(child.stdout), {
            inherited: false,
            proxy: true,
            preserved: true,
          });
          return 'invoked';
        },
      );
      assert.equal(result, 'invoked');
      assert.equal(process.env.ANTHROPIC_API_KEY, 'fixture-conflicting-key');
    } finally {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
      if (previousSentinel === undefined) delete process.env.FCC_TEST_PERMISSION_SENTINEL;
      else process.env.FCC_TEST_PERMISSION_SENTINEL = previousSentinel;
    }
  },
);

test(
  'optional pinned source transaction recovery derives paths from the verified archive',
  { skip: !process.env.FCC_TEST_ARCHIVE },
  async (t) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fcc-source-recovery-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const installId = randomUUID();
    const runtimeDirectory = `runtime-${FCC.commit}-${installId}`;
    const lifecycle = JSON.stringify({
      schemaVersion: 2,
      installId,
      runtimeDirectory,
      phase: 'building',
      createdAt: new Date().toISOString(),
    });
    await mkdir(path.join(root, '.latchkit'));
    await mkdir(path.join(root, runtimeDirectory));
    await writeFile(path.join(root, 'fcc-lifecycle.json'), lifecycle);
    const manifest = JSON.stringify({
      schemaVersion: 2,
      tool: 'fcc',
      resources: { 'fcc-lifecycle.json': createHash('sha256').update(lifecycle).digest('hex') },
    });
    await writeFile(path.join(root, '.latchkit', 'manifest.json'), manifest);
    const relative = `${runtimeDirectory}/uv.lock`;
    await assert.rejects(
      applyRegisteredTransaction(root, {
        operation: 'materialize-fcc-source',
        registry: createResourceRegistry([{ id: 'uv.lock', path: relative }]),
        changes: [{ resourceId: 'uv.lock', bytes: 'partial-source' }],
        manifest,
        faultBoundary: () => {
          throw new Error('interrupted');
        },
      }),
      /interrupted/,
    );
    await writeFile(path.join(root, relative), 'partial-source');
    const result = await recoverFcc({ root, archive: process.env.FCC_TEST_ARCHIVE });
    assert.equal(result.action, 'recovered');
    await assert.rejects(readFile(path.join(root, relative)), { code: 'ENOENT' });
    assert.equal(
      JSON.parse(await readFile(path.join(root, 'fcc-lifecycle.json'))).phase,
      'abandoned',
    );
  },
);

test(
  'optional installed FCC pin enforces actual config semantics and child-only home',
  { skip: !process.env.FCC_TEST_ROOT },
  async (t) => {
    const root = process.env.FCC_TEST_ROOT;
    const state = JSON.parse(await readFile(path.join(root, 'fcc-state.json')));
    assert.equal(state.commit, FCC.commit);
    const runtime = path.join(root, state.runtimeDirectory);
    const python = path.join(
      runtime,
      'venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    );
    const profile = await mkdtemp(path.join(os.tmpdir(), 'fcc-contract-'));
    t.after(() => rm(profile, { recursive: true, force: true }));
    await mkdir(path.join(profile, '.fcc'));
    await writeFile(
      path.join(profile, '.fcc', '.env'),
      'FCC_CONFIG_SCHEMA=1\nANTHROPIC_AUTH_TOKEN=fixture-retained-token\nPROXY_AUTH_ENABLED=false\nHOST=0.0.0.0\nMODEL_FALLBACKS=groq/fixture\nMESSAGING_PLATFORM=discord\nMODEL_OPUS=groq/fixture\n',
    );
    const script = [
      'import json, os',
      'from pathlib import Path',
      'from importlib.metadata import version',
      'from free_claude_code.config.loader import get_settings',
      'settings = get_settings()',
      'print(json.dumps({"version": version("free-claude-code"), "host": settings.host, "port": settings.port, "proxy_auth": settings.proxy_auth_enabled, "retained_token": settings.proxy_auth_token == "fixture-retained-token", "messaging": settings.messaging_platform, "fallbacks": settings.model_fallbacks, "opus": settings.model_opus, "browser": settings.open_admin_browser, "private_home": str(Path.home()) == os.environ["USERPROFILE"]}))',
    ].join('\n');
    const result = JSON.parse(
      await runBounded(python, ['-I', '-B', '-c', script], runtime, {
        ...systemEnvironment(),
        HOME: profile,
        USERPROFILE: profile,
        ANTHROPIC_AUTH_TOKEN: 'fixture-process-token',
        ...FCC_START_ENVIRONMENT,
      }),
    );
    assert.deepEqual(result, {
      version: FCC.version,
      host: '127.0.0.1',
      port: 8082,
      proxy_auth: true,
      retained_token: true,
      messaging: 'none',
      fallbacks: null,
      opus: null,
      browser: false,
      private_home: true,
    });
  },
);
