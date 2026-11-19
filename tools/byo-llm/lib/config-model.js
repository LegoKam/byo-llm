/*
 * The BYO LLM configuration model and its mapping to a DA sheet.
 *
 * The configuration lives in the site's hidden /.da folder, the place DA uses for
 * integration secrets (see "Send to Adobe Target" and the translation connectors).
 * The values sit in `private-` tabs, which DA never previews or publishes.
 *
 * This module is pure: no DOM, no network. The browser and the App Builder action share it.
 */

export const SECRET_PATH = '/.da/byo-llm.json';
export const SHEET_CONNECTIONS = 'private-connections';
export const SHEET_SETTINGS = 'private-settings';
const INFO_NOTE = 'BYO LLM settings for Experience Workspace. Managed by the BYO LLM plugin. '
  + 'The LLM credentials are in the private tabs. Do not preview or publish this sheet.';

/**
 * Provider catalogue. `endpoint` is the default base URL ('' means the admin must enter one),
 * `images` / `pdf` say which attachment kinds the provider's API accepts natively.
 */
export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    endpointHint: 'https://api.openai.com/v1',
    modelHint: 'e.g. gpt-4o',
    keyRequired: true,
    images: true,
    pdf: true,
  },
  'azure-openai': {
    label: 'Azure OpenAI',
    endpoint: '',
    endpointHint: 'https://your-resource.openai.azure.com',
    modelHint: 'Your deployment name',
    modelLabel: 'Deployment',
    keyRequired: true,
    images: true,
    pdf: false,
    apiVersion: '2024-10-21',
  },
  anthropic: {
    label: 'Anthropic Claude',
    endpoint: 'https://api.anthropic.com',
    endpointHint: 'https://api.anthropic.com',
    modelHint: 'e.g. claude-sonnet-4-5',
    keyRequired: true,
    images: true,
    pdf: true,
  },
  gemini: {
    label: 'Google Gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    endpointHint: 'https://generativelanguage.googleapis.com/v1beta',
    modelHint: 'e.g. gemini-2.5-flash',
    keyRequired: true,
    images: true,
    pdf: true,
  },
  'openai-compatible': {
    label: 'OpenAI-compatible (in-house gateway, Ollama, vLLM, LiteLLM…)',
    endpoint: '',
    endpointHint: 'https://llm.your-company.com/v1',
    modelHint: 'The model name your endpoint expects',
    keyRequired: false,
    images: true,
    pdf: false,
    customKeyHeader: true,
  },
};

const CONNECTION_FIELDS = ['name', 'provider', 'endpoint', 'model', 'apiKey', 'apiVersion', 'keyHeader'];
const SETTING_KEYS = ['default', 'brandGuidelines', 'proxyUrl'];

const str = (value) => (value === undefined || value === null ? '' : String(value).trim());

export function emptyConfig() {
  return { connections: [], settings: { default: '', brandGuidelines: '', proxyUrl: '' } };
}

export function normalizeConnection(raw = {}) {
  const conn = {};
  CONNECTION_FIELDS.forEach((field) => { conn[field] = str(raw[field]); });
  conn.provider = conn.provider.toLowerCase();
  return conn;
}

const isLocalHost = (hostname) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

/**
 * Checks an endpoint URL. Plain http is only acceptable for a model on the author's own machine.
 * @returns {string|null} An error message, or null if the URL is usable.
 */
export function validateEndpoint(value, { allowLocalHttp = true } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'Enter a full URL, starting with https://';
  }
  if (url.username || url.password) return 'Do not put credentials in the URL. Use the API key field.';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && allowLocalHttp && isLocalHost(url.hostname)) return null;
  return 'The URL must start with https://';
}

/**
 * @param {object} conn A normalized connection.
 * @param {object} [options]
 * @param {string[]} [options.otherNames] Names of the other connections, to catch duplicates.
 * @returns {Object<string,string>} Field name to error message. Empty when valid.
 */
export function validateConnection(conn, { otherNames = [] } = {}) {
  const errors = {};
  const provider = PROVIDERS[conn.provider];

  if (!conn.name) errors.name = 'Give this connection a name.';
  else if (conn.name.length > 60) errors.name = 'Use 60 characters or fewer.';
  else if (otherNames.some((name) => name.toLowerCase() === conn.name.toLowerCase())) {
    errors.name = 'Another connection already uses this name.';
  }

  if (!provider) {
    errors.provider = 'Choose a provider.';
    return errors;
  }

  const endpoint = conn.endpoint || provider.endpoint;
  if (!endpoint) errors.endpoint = 'Enter the endpoint URL.';
  else {
    const endpointError = validateEndpoint(endpoint);
    if (endpointError) errors.endpoint = endpointError;
  }

  if (!conn.model) errors.model = `Enter the ${provider.modelLabel ? provider.modelLabel.toLowerCase() : 'model'} name.`;
  if (provider.keyRequired && !conn.apiKey) errors.apiKey = 'Enter the API key.';
  if (conn.keyHeader && !/^[A-Za-z0-9-]+$/.test(conn.keyHeader)) {
    errors.keyHeader = 'A header name can only contain letters, digits and hyphens.';
  }
  return errors;
}

export function validateSettings(settings) {
  const errors = {};
  if (settings.proxyUrl) {
    const error = validateEndpoint(settings.proxyUrl);
    if (error) errors.proxyUrl = error;
  }
  return errors;
}

export function findConnection(config, name) {
  if (!name) return undefined;
  return config.connections.find((conn) => conn.name === name);
}

/** The connection authors get when they have not picked one: the configured default, else the first. */
export function getDefaultConnection(config) {
  return findConnection(config, config.settings.default) || config.connections[0];
}

/** Shows only the last four characters of a key. */
export function maskKey(key) {
  if (!key) return '';
  return key.length <= 8 ? '••••••••' : `••••••••${key.slice(-4)}`;
}

const rows = (sheet) => (Array.isArray(sheet?.data) ? sheet.data : []);

function settingsFromRows(data) {
  const settings = emptyConfig().settings;
  data.forEach((row) => {
    const key = str(row.key);
    if (SETTING_KEYS.includes(key)) settings[key] = str(row.value);
  });
  return settings;
}

/**
 * Reads a configuration from DA sheet JSON. Accepts what this plugin writes (private tabs),
 * and two shapes an admin might create by hand in the sheet editor: public `connections` /
 * `settings` tabs, or one key/value tab describing a single connection.
 */
export function parseSheet(json) {
  const config = emptyConfig();
  if (!json || typeof json !== 'object') return config;

  const privateSheets = json[':private'] || {};
  const connectionSheet = privateSheets[SHEET_CONNECTIONS] || json.connections;
  const settingsSheet = privateSheets[SHEET_SETTINGS] || json.settings;

  if (connectionSheet) {
    config.connections = rows(connectionSheet)
      .map(normalizeConnection)
      .filter((conn) => conn.name && conn.provider);
    config.settings = settingsFromRows(rows(settingsSheet));
    return config;
  }

  // A single key/value sheet: | key | value | with provider, endpoint, model, apiKey rows.
  const flat = {};
  rows(json).forEach((row) => { if (str(row.key)) flat[str(row.key)] = str(row.value); });
  if (flat.provider) {
    config.connections = [normalizeConnection({ name: flat.name || 'Default', ...flat })];
    config.settings = settingsFromRows(rows(json));
  }
  return config;
}

const toSheetData = (data) => ({ total: data.length, limit: data.length, offset: 0, data });

/** Writes the configuration the way DA's sheet editor would: one public note tab, two private tabs. */
export function toSheet(config) {
  const connections = config.connections.map((raw) => {
    const conn = normalizeConnection(raw);
    return Object.fromEntries(CONNECTION_FIELDS.map((field) => [field, conn[field]]));
  });
  const settings = SETTING_KEYS.map((key) => ({ key, value: str(config.settings?.[key]) }));

  return {
    ...toSheetData([{ key: 'about', value: INFO_NOTE }]),
    ':sheetname': 'info',
    ':type': 'sheet',
    ':private': {
      [SHEET_CONNECTIONS]: toSheetData(connections),
      [SHEET_SETTINGS]: toSheetData(settings),
    },
  };
}
