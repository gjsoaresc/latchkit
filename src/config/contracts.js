export const CURRENT_CONFIG_SCHEMA_VERSION = 3;
export const SUPPORTED_CONFIG_SCHEMA_VERSIONS = Object.freeze([1, 2, 3]);
export const MANIFEST_SCHEMA_VERSION = 2;

const CONFIG_FIELDS = new Map([
  [1, new Set(['schemaVersion', 'providers', 'skills'])],
  [2, new Set(['schemaVersion', 'providers', 'skills', 'providerSettings'])],
  [3, new Set(['schemaVersion', 'providers', 'skills', 'providerSettings', 'packs'])],
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
  if (config.schemaVersion >= 2) {
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
  if (config.schemaVersion === 3) {
    if (!Array.isArray(config.packs))
      throw new ConfigContractError('Expected an array.', '$.packs');
    const ids = new Set();
    validated.packs = config.packs.map((pack, index) => {
      const packPath = `$.packs[${index}]`;
      if (
        !record(pack) ||
        !['id', 'version', 'source', 'pinned'].every((key) => Object.hasOwn(pack, key)) ||
        Object.keys(pack).length !== 4
      )
        throw new ConfigContractError('Expected a complete pack selection.', packPath);
      if (
        typeof pack.id !== 'string' ||
        !/^[a-z][a-z0-9-]{0,62}$/.test(pack.id) ||
        ids.has(pack.id)
      )
        throw new ConfigContractError('Expected a unique portable pack ID.', `${packPath}.id`);
      ids.add(pack.id);
      if (
        typeof pack.version !== 'string' ||
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pack.version)
      )
        throw new ConfigContractError('Expected a semantic version.', `${packPath}.version`);
      if (!record(pack.source) || !Object.hasOwn(pack.source, 'type'))
        throw new ConfigContractError('Expected a pack source.', `${packPath}.source`);
      if (pack.source.type === 'local') {
        if (
          Object.keys(pack.source).length !== 2 ||
          typeof pack.source.path !== 'string' ||
          !pack.source.path
        )
          throw new ConfigContractError('Local packs require a source path.', `${packPath}.source`);
      } else if (pack.source.type !== 'bundled' || Object.keys(pack.source).length !== 1)
        throw new ConfigContractError(
          'Expected a bundled or local pack source.',
          `${packPath}.source`,
        );
      if (typeof pack.pinned !== 'boolean')
        throw new ConfigContractError('Expected a boolean.', `${packPath}.pinned`);
      return cloneJson(pack, packPath);
    });
  }
  return validated;
}

export function validateManifest(manifest, allowedPaths) {
  if (!record(manifest))
    throw new ConfigContractError('Expected an object.', '$', 'MANIFEST_INVALID');
  const fields = new Set(['schemaVersion', 'files', 'packs']);
  for (const key of Object.keys(manifest)) {
    if (!fields.has(key))
      throw new ConfigContractError(`Unknown field "${key}".`, `$.${key}`, 'MANIFEST_INVALID');
  }
  if (![1, MANIFEST_SCHEMA_VERSION].includes(manifest.schemaVersion)) {
    throw new ConfigContractError(
      `Expected schema version 1 or ${MANIFEST_SCHEMA_VERSION}.`,
      '$.schemaVersion',
      'MANIFEST_INVALID',
    );
  }
  if (!record(manifest.files))
    throw new ConfigContractError('Expected an object.', '$.files', 'MANIFEST_INVALID');
  const files = {};
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const entryPath = `$.files.${relative}`;
    if (allowedPaths && !allowedPaths.has(relative))
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
  if (manifest.schemaVersion === 1)
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, files, packs: [] };
  if (!Array.isArray(manifest.packs))
    throw new ConfigContractError('Expected an array.', '$.packs', 'MANIFEST_INVALID');
  const packs = manifest.packs.map((pack, index) => {
    if (
      !record(pack) ||
      typeof pack.id !== 'string' ||
      typeof pack.version !== 'string' ||
      !record(pack.source)
    )
      throw new ConfigContractError(
        'Expected installed pack metadata.',
        `$.packs[${index}]`,
        'MANIFEST_INVALID',
      );
    return cloneJson(pack, `$.packs[${index}]`);
  });
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, files, packs };
}
