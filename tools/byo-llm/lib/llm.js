/*
 * Sends a request to the LLM, either straight from the browser or through the
 * App Builder proxy when the site settings name one.
 */

import { callLlm, LlmError } from './providers.js';

// Adobe I/O Runtime accepts request bodies up to 1 MB.
export const PROXY_MAX_BYTES = 950 * 1024;

const byteLength = (text) => new TextEncoder().encode(text).length;

async function viaProxy({ proxyUrl, connection, request, context, token, fetch, signal }) {
  const body = JSON.stringify({
    org: context.org,
    site: context.site,
    connection: connection.name,
    request,
  });
  if (byteLength(body) > PROXY_MAX_BYTES) {
    throw new LlmError('invalid', 'This request is too large for the proxy (the limit is about 1 MB). Remove an attachment or select less content.');
  }

  let resp;
  try {
    resp = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw new LlmError('aborted', 'Cancelled.');
    throw new LlmError('network', 'Could not reach the BYO LLM proxy. Check the proxy URL in the settings.');
  }

  let json;
  try {
    json = await resp.json();
  } catch {
    json = undefined;
  }
  if (!resp.ok || !json || json.error) {
    const message = typeof json?.error === 'string' ? json.error : `The BYO LLM proxy returned an error (${resp.status}).`;
    throw new LlmError(json?.code || 'upstream', message, resp.status);
  }
  if (typeof json.text !== 'string' || !json.text.trim()) {
    throw new LlmError('bad-response', 'The BYO LLM proxy returned an empty response.');
  }
  return json;
}

/**
 * @param {object} options
 * @param {object} options.config The loaded configuration.
 * @param {object} options.connection The connection to use (one of config.connections).
 * @param {object} options.request A provider-neutral request.
 * @param {{ org: string, site: string }} options.context
 * @param {string} options.token The user's IMS token. Only sent to the proxy, never to an LLM.
 * @param {Function} [options.fetch]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ text: string, model: string, truncated: boolean, usage?: object }>}
 */
export async function generate({
  config, connection, request, context, token, fetch = globalThis.fetch.bind(globalThis), signal,
}) {
  const { proxyUrl } = config.settings;
  if (proxyUrl) {
    return viaProxy({ proxyUrl, connection, request, context, token, fetch, signal });
  }
  try {
    return await callLlm(connection, request, { fetch, signal });
  } catch (error) {
    if (error.code === 'network') {
      // A browser reports a blocked cross-origin (CORS) request as a plain network failure.
      throw new LlmError('network', `${error.message} Check the endpoint URL and your network. If the endpoint does not accept requests from a browser, an admin can route requests through the proxy (see Settings).`);
    }
    throw error;
  }
}
