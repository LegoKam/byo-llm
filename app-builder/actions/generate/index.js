/*
 * BYO LLM proxy: an Adobe App Builder web action that calls the LLM on behalf of the plugin.
 *
 * Use it when the LLM endpoint cannot be called from a browser: it sends no CORS headers, or
 * it only accepts requests from allow-listed addresses.
 *
 * The caller sends its Experience Workspace (IMS) token. The action uses that token to read
 * the site's BYO LLM settings sheet from DA, so a caller can only use the connections of a
 * site whose settings DA lets them read. The action stores nothing.
 *
 * The proxy is about reachability, not secrecy: authors can read the settings sheet either
 * way, so it does not hide the API key from them.
 *
 * Request:  POST { org, site, connection, request }   Authorization: Bearer <IMS token>
 * Response: 200 { text, model, truncated, usage }  |  4xx/5xx { error, code }
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { findConnection } from '../../../tools/byo-llm/lib/config-model.js';
import { buildRequest, callLlm, LlmError } from '../../../tools/byo-llm/lib/providers.js';
import {
  DEFAULT_ORIGINS, StoreError, createAuthedFetch, createStore,
} from '../../../tools/byo-llm/lib/store.js';
import {
  errorResponse, getBearerToken, isAllowed, jsonResponse, parseAllowList,
} from '../utils.js';

// The action itself is limited to 60 s (app.config.yaml); stop a little earlier to answer cleanly.
const LLM_TIMEOUT = 55000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ROLES = ['user', 'assistant'];
const MAX_MESSAGES = 40;

const STATUS_BY_CODE = {
  invalid: 400,
  unsupported: 400,
  auth: 502,
  'not-found': 502,
  'rate-limit': 429,
  network: 502,
  blocked: 422,
  'bad-response': 502,
  upstream: 502,
};

const isString = (value) => typeof value === 'string';

function isValidPart(part) {
  if (!part || typeof part !== 'object') return false;
  if (part.type === 'text') return isString(part.text);
  if (part.type === 'image' || part.type === 'file') {
    return isString(part.mediaType) && /^[\w.+-]+\/[\w.+-]+$/.test(part.mediaType)
      && isString(part.data) && /^[A-Za-z0-9+/]*={0,2}$/.test(part.data);
  }
  return false;
}

/** Copies the request field by field, so nothing but the documented shape reaches the LLM. */
export function readRequest(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.messages)) return null;
  if (!raw.messages.length || raw.messages.length > MAX_MESSAGES) return null;
  if (raw.system !== undefined && !isString(raw.system)) return null;

  const messages = [];
  for (const message of raw.messages) {
    if (!message || !ROLES.includes(message.role) || !Array.isArray(message.content)) return null;
    if (!message.content.length || !message.content.every(isValidPart)) return null;
    messages.push({
      role: message.role,
      content: message.content.map((part) => (part.type === 'text'
        ? { type: 'text', text: part.text }
        : {
          type: part.type, mediaType: part.mediaType, data: part.data, name: isString(part.name) ? part.name : undefined,
        })),
    });
  }

  const request = { system: raw.system || '', messages };
  if (Number.isInteger(raw.maxTokens) && raw.maxTokens > 0 && raw.maxTokens <= 64000) {
    request.maxTokens = raw.maxTokens;
  }
  return request;
}

function isPrivateV4(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

export function isPrivateAddress(address) {
  const family = isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return lower === '::' || lower === '::1'
    || lower.startsWith('::ffff:')
    || /^f[cd]/.test(lower)
    || /^fe[89ab]/.test(lower)
    || lower.startsWith('ff');
}

/**
 * The endpoint comes from a sheet that site admins edit. Refuse anything that is not a public
 * https address, so the action cannot be pointed at the network it runs in.
 */
export async function assertPublicEndpoint(endpoint, lookup = dnsLookup) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new LlmError('invalid', 'The endpoint URL of this connection is not a valid URL.');
  }
  if (url.protocol !== 'https:') {
    throw new LlmError('invalid', 'The proxy only calls https endpoints.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
    } catch {
      throw new LlmError('network', `Could not resolve ${host}.`);
    }
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new LlmError('invalid', 'The proxy only calls endpoints on the public internet.');
  }
}

/**
 * @param {object} [deps] Seams for the local dev server and the tests. They are fixed when the
 *  action is created and cannot be set by a request.
 * @param {Function} [deps.fetch]
 * @param {object} [deps.origins] DA / AEM API origins.
 * @param {Function} [deps.lookup] DNS lookup.
 * @param {boolean} [deps.allowInsecureEndpoints] Skips the public-https check (local mocks only).
 */
export function createMain({
  fetch = globalThis.fetch,
  origins = DEFAULT_ORIGINS,
  lookup = dnsLookup,
  allowInsecureEndpoints = false,
} = {}) {
  return async function main(params = {}) {
    const method = (params.__ow_method || 'post').toLowerCase();
    if (method !== 'post') return errorResponse(405, 'invalid', 'Use POST.');

    const allowList = parseAllowList(params.BYO_LLM_ALLOWED_ORGS);
    if (!allowList.length) {
      return errorResponse(500, 'invalid', 'The BYO LLM proxy is not configured: BYO_LLM_ALLOWED_ORGS is empty. Set it and deploy again.');
    }

    const token = getBearerToken(params);
    if (!token) return errorResponse(401, 'auth', 'Sign in to Experience Workspace to use the BYO LLM proxy.');

    const { org, site, connection: connectionName } = params;
    if (!isString(org) || !NAME.test(org) || !isString(site) || !NAME.test(site)) {
      return errorResponse(400, 'invalid', 'The request must name an org and a site.');
    }
    if (!isAllowed(allowList, org, site)) {
      return errorResponse(403, 'auth', `This BYO LLM proxy does not serve ${org}/${site}. Ask the person who deployed it to add the organisation to BYO_LLM_ALLOWED_ORGS.`);
    }
    if (!isString(connectionName) || !connectionName) {
      return errorResponse(400, 'invalid', 'The request must name a connection.');
    }
    const request = readRequest(params.request);
    if (!request) return errorResponse(400, 'invalid', 'The request is not in the expected format.');

    // Reading the settings with the caller's own token is the authorisation check.
    let config;
    try {
      const store = createStore({
        org,
        site,
        origins,
        fetch: createAuthedFetch(() => token, { fetch, origins }),
        plainFetch: fetch,
      });
      ({ config } = await store.load());
    } catch (error) {
      if (error instanceof StoreError) {
        const status = { unauthenticated: 401, forbidden: 403 }[error.code] || 502;
        return errorResponse(status, status === 502 ? 'upstream' : 'auth', error.message);
      }
      console.error('byo-llm: could not load the settings', error?.message);
      return errorResponse(502, 'upstream', 'Could not load the BYO LLM settings.');
    }

    const connection = findConnection(config, connectionName);
    if (!connection) {
      return errorResponse(404, 'not-found', `This site has no LLM connection named "${connectionName}". Reload the plugin to get the current list.`);
    }

    try {
      if (!allowInsecureEndpoints) {
        // Check the URL that will actually be called, not just the configured base.
        await assertPublicEndpoint(buildRequest(connection, request).url, lookup);
      }
      const result = await callLlm(connection, request, {
        fetch,
        signal: AbortSignal.timeout(LLM_TIMEOUT),
        // A redirect could lead somewhere the check above did not see.
        fetchOptions: { redirect: 'error' },
      });
      return jsonResponse(200, {
        text: result.text,
        model: result.model,
        truncated: result.truncated,
        usage: result.usage,
      });
    } catch (error) {
      if (error instanceof LlmError) {
        if (error.code === 'aborted') {
          return errorResponse(504, 'upstream', 'The LLM took too long to answer. Try again with less content.');
        }
        return errorResponse(STATUS_BY_CODE[error.code] || 502, error.code, error.message);
      }
      // Never log the request or the connection: they hold content and the API key.
      console.error('byo-llm: unexpected error', error?.name, error?.message);
      return errorResponse(500, 'upstream', 'The BYO LLM proxy failed unexpectedly.');
    }
  };
}

export const main = createMain();
