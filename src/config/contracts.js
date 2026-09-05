export const CURRENT_CONFIG_SCHEMA_VERSION = 2;
export const SUPPORTED_CONFIG_SCHEMA_VERSIONS = Object.freeze([1, 2]);
export const MANIFEST_SCHEMA_VERSION = 1;

const CONFIG_FIELDS = new Map([
  [1, new Set(['schemaVersion', 'providers', 'skills'])],
  [2, new Set(['schemaVersion', 'providers', 'skills', 'providerSettings'])],
]);

export class ConfigContractError extends Error {
  constructor(message, path = '$', code = 'CONFIG_INVALID') {
    super(`${path}: ${message}`);
    this.name = 'ConfigContractError';
    this.code = code;
    this.path = path;
  }
}

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${path}[${index}]`));
  if (record(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item, `${path}.${key}`)]),
    );
  }
  throw new ConfigContractError('Expected a JSON value.', path);
}

function validateSelection(config, key, allowedIds) {
  const value = config[key];
  if (!Array.isArray(value)) throw new ConfigContractError('Expected an array.', `$.${key}`);
  const seen = new Set();
  return value.map((id, index) => {
    const itemPath = `$.${key}[${index}]`;
    if (typeof id !== 'string') throw new ConfigContractError('Expected a string ID.', itemPath);
    if (!allowedIds.has(id)) throw new ConfigContractError(`Unknown ID "${id}".`, itemPath);
    if (seen.has(id)) throw new ConfigContractError(`Duplicate ID "${id}".`, itemPath);
    seen.add(id);
    return id;
  });
}

export function parseConfig(raw, options) {
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new ConfigContractError(`Invalid JSON (${error.message}).`, '$', 'CONFIG_INVALID_JSON');
  }
  return validateConfig(config, options);
}

export function validateConfig(config, { providerIds, skillIds }) {
  if (!record(config)) throw new ConfigContractError('Expected an object.');
  if (!Number.isInteger(config.schemaVersion)) {
    throw new ConfigContractError('Expected an integer schema version.', '$.schemaVersion');
  }
  if (!SUPPORTED_CONFIG_SCHEMA_VERSIONS.includes(config.schemaVersion)) {
    throw new ConfigContractError(
      `Unsupported schema version ${config.schemaVersion}; supported versions are ${SUPPORTED_CONFIG_SCHEMA_VERSIONS.join(', ')}.`,
      '$.schemaVersion',
      'CONFIG_UNSUPPORTED_VERSION',
    );
  }
  const fields = CONFIG_FIELDS.get(config.schemaVersion);
  for (const key of Object.keys(config)) {
    if (!fields.has(key)) throw new ConfigContractError(`Unknown field "${key}".`, `$.${key}`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(config, key))
      throw new ConfigContractError('Required field is missing.', `$.${key}`);
  }

  const validated = {
    schemaVersion: config.schemaVersion,
    providers: validateSelection(config, 'providers', new Set(providerIds)),
    skills: validateSelection(config, 'skills', new Set(skillIds)),
  };
  if (config.schemaVersion === 2) {
    if (!record(config.providerSettings)) {
      throw new ConfigContractError(
        'Expected an object keyed by provider ID.',
        '$.providerSettings',
      );
    }
    const providerSettings = [];
    for (const [providerId, settings] of Object.entries(config.providerSettings)) {
      const settingsPath = `$.providerSettings.${providerId}`;
      if (!providerIds.includes(providerId))
        throw new ConfigContractError(`Unknown provider ID "${providerId}".`, settingsPath);
      if (!record(settings))
        throw new ConfigContractError('Expected a provider settings object.', settingsPath);
      providerSettings.push([providerId, cloneJson(settings, settingsPath)]);
    }
    validated.providerSettings = Object.fromEntries(providerSettings);
  }
  return validated;
}

export function validateManifest(manifest, allowedPaths) {
  if (!record(manifest))
    throw new ConfigContractError('Expected an object.', '$', 'MANIFEST_INVALID');
  const fields = new Set(['schemaVersion', 'files']);
  for (const key of Object.keys(manifest)) {
    if (!fields.has(key))
      throw new ConfigContractError(`Unknown field "${key}".`, `$.${key}`, 'MANIFEST_INVALID');
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ConfigContractError(
      `Expected schema version ${MANIFEST_SCHEMA_VERSION}.`,
      '$.schemaVersion',
      'MANIFEST_INVALID',
    );
  }
  if (!record(manifest.files))
    throw new ConfigContractError('Expected an object.', '$.files', 'MANIFEST_INVALID');
  const files = {};
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const entryPath = `$.files.${relative}`;
    if (!allowedPaths.has(relative))
      throw new ConfigContractError('Unknown managed file path.', entryPath, 'MANIFEST_INVALID');
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new ConfigContractError(
        'Expected a lowercase SHA-256 digest.',
        entryPath,
        'MANIFEST_INVALID',
      );
    }
    files[relative] = digest;
  }
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, files };
}
