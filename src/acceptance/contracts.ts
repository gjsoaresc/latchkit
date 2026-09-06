import path from 'node:path';
import { validateCommandPlan } from '../providers/contracts.js';
import type { CommandPlan } from '../providers/contracts.js';
import type { UnknownRecord } from '../types.js';

export const ACCEPTANCE_CHECK_SCHEMA_VERSION = 1;
export const ACCEPTANCE_CHECK_TYPES = Object.freeze(['cli', 'http', 'browser', 'manual']);
export const ACCEPTANCE_ARTIFACT_ROOT = '.latchkit/tasks/acceptance-evidence';

export type AcceptanceCheckType = (typeof ACCEPTANCE_CHECK_TYPES)[number];
export type Assertion = UnknownRecord & { kind: string };
export type BrowserAction =
  | { kind: 'click'; selector: string }
  | { kind: 'fill'; selector: string; value: string }
  | { kind: 'press'; selector: string; key: string }
  | { kind: 'goto'; path: string }
  | { kind: 'close' };
export type Fixture = {
  plan: Readonly<CommandPlan>;
  port: number;
  portEnvironment: string;
  readinessPath: string;
  readinessTimeoutMs: number;
};
type CommonCheck = {
  id: string;
  criterionId: string;
  label: string;
  timeoutMs: number;
  outputLimitBytes: number;
  fixture?: Fixture;
};
export type CliAcceptanceCheck = CommonCheck & {
  type: 'cli';
  plan: Readonly<CommandPlan>;
  fixture?: undefined;
};
export type ManualAcceptanceCheck = CommonCheck & {
  type: 'manual';
  instructions: string;
  fixture?: undefined;
};
export type HttpAcceptanceCheck = CommonCheck & {
  type: 'http';
  target: string;
  assertions: Assertion[];
  method: string;
  followRedirects: boolean;
  body?: string;
};
export type BrowserAcceptanceCheck = CommonCheck & {
  type: 'browser';
  target: string;
  assertions: Assertion[];
  actions: BrowserAction[];
  browser: 'chromium' | 'firefox' | 'webkit';
  captureScreenshot: boolean;
  captureTrace: boolean;
};
export type AcceptanceCheck =
  CliAcceptanceCheck | ManualAcceptanceCheck | HttpAcceptanceCheck | BrowserAcceptanceCheck;
export type AcceptanceDocument = { schemaVersion: 1; checks: AcceptanceCheck[] };

export class AcceptanceError extends Error {
  code: string;
  path: string;
  bytes?: number;
  constructor(message: string, code = 'ACCEPTANCE_INVALID', field = '$') {
    super(`${field}: ${message}`);
    this.name = 'AcceptanceError';
    this.code = code;
    this.path = field;
  }
}

const object = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new AcceptanceError('Expected a non-empty string.', 'ACCEPTANCE_INVALID', field);
  return value;
};
const positive = (value: unknown, field: string, fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
    throw new AcceptanceError('Expected a positive integer.', 'ACCEPTANCE_INVALID', field);
  return value;
};

function target(
  value: unknown,
  field: string,
  { browser = false }: { browser?: boolean } = {},
): string {
  const declared = requiredString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(declared.replaceAll('${PORT}', '1'));
  } catch {
    throw new AcceptanceError('Expected an absolute HTTP(S) URL.', 'ACCEPTANCE_INVALID', field);
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new AcceptanceError('Only HTTP(S) targets are supported.', 'ACCEPTANCE_INVALID', field);
  if (parsed.username || parsed.password)
    throw new AcceptanceError(
      'Credentials must not be embedded in targets.',
      'ACCEPTANCE_INVALID',
      field,
    );
  if (browser && !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname))
    throw new AcceptanceError(
      'Automated browser targets must be loopback local.',
      'REMOTE_BROWSER_TARGET_REFUSED',
      field,
    );
  return declared;
}

function fixture(value: unknown, field: string): Fixture | undefined {
  if (value === undefined) return undefined;
  if (!object(value))
    throw new AcceptanceError('Expected a fixture object.', 'ACCEPTANCE_INVALID', field);
  const plan = validateCommandPlan(value.plan);
  const port = value.port === undefined ? 0 : value.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new AcceptanceError(
      'Fixture port must be between 0 and 65535.',
      'ACCEPTANCE_INVALID',
      `${field}.port`,
    );
  return {
    plan,
    port,
    portEnvironment:
      value.portEnvironment === undefined
        ? 'PORT'
        : requiredString(value.portEnvironment, `${field}.portEnvironment`),
    readinessPath: (() => {
      const readiness = value.readinessPath ?? '/';
      if (typeof readiness !== 'string' || !readiness.startsWith('/') || readiness.startsWith('//'))
        throw new AcceptanceError(
          'Fixture readinessPath must be a local absolute path.',
          'ACCEPTANCE_INVALID',
          `${field}.readinessPath`,
        );
      return readiness;
    })(),
    readinessTimeoutMs: positive(value.readinessTimeoutMs, `${field}.readinessTimeoutMs`, 10_000),
  };
}

function assertions(value: unknown, field: string): Assertion[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new AcceptanceError(
      'Expected at least one observable assertion.',
      'ACCEPTANCE_INVALID',
      field,
    );
  return value.map((assertion, index) => {
    const at = `${field}[${index}]`;
    if (!object(assertion))
      throw new AcceptanceError('Expected an assertion object.', 'ACCEPTANCE_INVALID', at);
    requiredString(assertion.kind, `${at}.kind`);
    return structuredClone(assertion) as Assertion;
  });
}

function validateObservableAssertions(
  type: 'http' | 'browser',
  values: Assertion[],
  field: string,
): Assertion[] {
  const supported =
    type === 'http'
      ? new Set(['status', 'header', 'body-includes', 'json'])
      : new Set(['visible', 'text', 'url', 'title']);
  for (const [index, assertion] of values.entries()) {
    const at = `${field}[${index}]`;
    if (!supported.has(assertion.kind))
      throw new AcceptanceError(
        `Assertion ${assertion.kind} is not supported for ${type} checks.`,
        'ACCEPTANCE_INVALID',
        `${at}.kind`,
      );
    if (assertion.kind === 'status' && !Number.isInteger(assertion.equals))
      throw new AcceptanceError(
        'Status assertions require integer equals.',
        'ACCEPTANCE_INVALID',
        at,
      );
    if (assertion.kind === 'header') requiredString(assertion.name, `${at}.name`);
    if (assertion.kind === 'body-includes') requiredString(assertion.value, `${at}.value`);
    if (assertion.kind === 'json') requiredString(assertion.pointer, `${at}.pointer`);
    if (['visible', 'text'].includes(assertion.kind))
      requiredString(assertion.selector, `${at}.selector`);
    if (
      !['status', 'visible', 'body-includes', 'json'].includes(assertion.kind) &&
      assertion.equals === undefined &&
      typeof assertion.includes !== 'string'
    )
      throw new AcceptanceError('Assertion requires equals or includes.', 'ACCEPTANCE_INVALID', at);
  }
  return values;
}

function browserActions(value: unknown, field: string): BrowserAction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64)
    throw new AcceptanceError('Expected at most 64 browser actions.', 'ACCEPTANCE_INVALID', field);
  return value.map((action, index) => {
    const at = `${field}[${index}]`;
    if (
      !object(action) ||
      typeof action.kind !== 'string' ||
      !['click', 'fill', 'press', 'goto', 'close'].includes(action.kind)
    )
      throw new AcceptanceError('Unknown browser action.', 'ACCEPTANCE_INVALID', at);
    if (action.kind === 'goto') requiredString(action.path, `${at}.path`);
    else if (action.kind !== 'close') requiredString(action.selector, `${at}.selector`);
    if (action.kind === 'fill') requiredString(action.value, `${at}.value`);
    if (action.kind === 'press') requiredString(action.key, `${at}.key`);
    return structuredClone(action) as BrowserAction;
  });
}

function validateCheck(value: unknown, index: number): AcceptanceCheck {
  const field = `$.checks[${index}]`;
  if (!object(value))
    throw new AcceptanceError('Expected a check object.', 'ACCEPTANCE_INVALID', field);
  const id = requiredString(value.id, `${field}.id`);
  const criterionId = requiredString(value.criterionId, `${field}.criterionId`);
  const label = requiredString(value.label, `${field}.label`);
  const type = requiredString(value.type, `${field}.type`) as AcceptanceCheckType;
  if (!ACCEPTANCE_CHECK_TYPES.includes(type))
    throw new AcceptanceError('Unknown check type.', 'ACCEPTANCE_INVALID', `${field}.type`);
  const common: CommonCheck = {
    id,
    criterionId,
    label,
    timeoutMs: positive(value.timeoutMs, `${field}.timeoutMs`, 15_000),
    outputLimitBytes: positive(value.outputLimitBytes, `${field}.outputLimitBytes`, 64 * 1024),
    fixture: fixture(value.fixture, `${field}.fixture`),
  };
  if (type === 'cli') {
    if (value.fixture !== undefined)
      throw new AcceptanceError(
        'CLI checks do not manage fixture servers.',
        'ACCEPTANCE_INVALID',
        `${field}.fixture`,
      );
    return { ...common, type: 'cli', fixture: undefined, plan: validateCommandPlan(value.plan) };
  }
  if (type === 'manual') {
    if (value.fixture !== undefined)
      throw new AcceptanceError(
        'Manual checks do not manage fixture servers.',
        'ACCEPTANCE_INVALID',
        `${field}.fixture`,
      );
    return {
      ...common,
      type: 'manual',
      fixture: undefined,
      instructions: requiredString(value.instructions, `${field}.instructions`),
    };
  }
  const declaredAssertions = assertions(value.assertions, `${field}.assertions`);
  const check = {
    ...common,
    target: target(value.target, `${field}.target`, { browser: value.type === 'browser' }),
    assertions: validateObservableAssertions(
      type as 'http' | 'browser',
      declaredAssertions,
      `${field}.assertions`,
    ),
  };
  if (type === 'http') {
    const method =
      value.method === undefined ? 'GET' : requiredString(value.method, `${field}.method`);
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/i.test(method))
      throw new AcceptanceError(
        'Unsupported HTTP method.',
        'ACCEPTANCE_INVALID',
        `${field}.method`,
      );
    if (value.body !== undefined && typeof value.body !== 'string')
      throw new AcceptanceError(
        'HTTP body must be a string.',
        'ACCEPTANCE_INVALID',
        `${field}.body`,
      );
    return {
      ...check,
      type: 'http',
      method,
      followRedirects: value.followRedirects === true,
      body: value.body as string | undefined,
    };
  } else {
    const browser =
      value.browser === undefined ? 'chromium' : requiredString(value.browser, `${field}.browser`);
    if (!['chromium', 'firefox', 'webkit'].includes(browser))
      throw new AcceptanceError(
        'Unknown browser engine.',
        'ACCEPTANCE_INVALID',
        `${field}.browser`,
      );
    return {
      ...check,
      type: 'browser',
      actions: browserActions(value.actions, `${field}.actions`),
      browser: browser as BrowserAcceptanceCheck['browser'],
      captureScreenshot: value.captureScreenshot === true,
      captureTrace: value.captureTrace === true,
    };
  }
}

export function validateAcceptanceDocument(value: unknown): AcceptanceDocument {
  if (!object(value) || value.schemaVersion !== ACCEPTANCE_CHECK_SCHEMA_VERSION)
    throw new AcceptanceError('Expected acceptance check schemaVersion 1.');
  if (!Array.isArray(value.checks) || value.checks.length === 0 || value.checks.length > 64)
    throw new AcceptanceError('Expected 1 to 64 checks.', 'ACCEPTANCE_INVALID', '$.checks');
  const checks = value.checks.map(validateCheck);
  if (new Set(checks.map((check) => check.id)).size !== checks.length)
    throw new AcceptanceError('Check IDs must be unique.', 'ACCEPTANCE_INVALID', '$.checks');
  return { schemaVersion: 1, checks };
}

export function safeArtifactLocation(
  taskId: unknown,
  artifactId: unknown,
  name = 'evidence.json',
): string {
  for (const [value, label] of [
    [taskId, 'task'],
    [artifactId, 'artifact'],
  ]) {
    if (typeof value !== 'string' || !/^[a-z0-9_-]+$/i.test(value))
      throw new AcceptanceError(`Invalid ${label} storage identifier.`, 'ACCEPTANCE_PATH_INVALID');
  }
  if (!/^[a-z0-9_.-]+$/i.test(name) || name.includes('..'))
    throw new AcceptanceError('Invalid artifact filename.', 'ACCEPTANCE_PATH_INVALID');
  return path.posix.join(ACCEPTANCE_ARTIFACT_ROOT, taskId as string, artifactId as string, name);
}
