/*
 * Provider adapters. Each one turns a provider-neutral request into that provider's HTTP call
 * and its response back into plain text.
 *
 * Neutral request:
 *   {
 *     system: string,
 *     messages: [{ role: 'user' | 'assistant', content: [part, ...] }],
 *     maxTokens?: number,
 *   }
 * Parts:
 *   { type: 'text', text }
 *   { type: 'image', mediaType, data }          data is base64, no data: prefix
 *   { type: 'file', mediaType, data, name }     PDF only
 *
 * This module only uses fetch, URL and JSON, so it runs unchanged in the browser (direct mode)
 * and in the App Builder action (proxy mode).
 */

import { PROVIDERS } from './config-model.js';

// Anthropic requires max_tokens. The other providers default to the model's own limit.
const ANTHROPIC_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';

export class LlmError extends Error {
  /**
   * @param {string} code One of: invalid, auth, not-found, rate-limit, network, blocked,
   *  bad-response, upstream, aborted, unsupported.
   * @param {string} message Safe to show to an author. Never contains the API key.
   * @param {number} [status] The HTTP status of the LLM response, if there was one.
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
  }
}

const trimSlashes = (value) => value.replace(/\/+$/, '');

function endpointOf(connection) {
  const provider = PROVIDERS[connection.provider];
  if (!provider) throw new LlmError('invalid', `Unknown provider "${connection.provider}".`);
  const endpoint = connection.endpoint || provider.endpoint;
  if (!endpoint) throw new LlmError('invalid', 'This connection has no endpoint URL.');
  return endpoint;
}

const dataUrl = (part) => `data:${part.mediaType};base64,${part.data}`;

function assertSupported(connection, request) {
  const provider = PROVIDERS[connection.provider];
  const parts = request.messages.flatMap((message) => message.content);
  if (!provider.pdf && parts.some((part) => part.type === 'file')) {
    throw new LlmError('unsupported', `${provider.label} connections can't read PDF files. Attach text or images instead.`);
  }
  if (!provider.images && parts.some((part) => part.type === 'image')) {
    throw new LlmError('unsupported', `${provider.label} connections can't read images.`);
  }
}

/* ---------- OpenAI chat completions (OpenAI, Azure OpenAI, OpenAI-compatible) ---------- */

function openAiPart(part) {
  if (part.type === 'image') return { type: 'image_url', image_url: { url: dataUrl(part) } };
  if (part.type === 'file') return { type: 'file', file: { filename: part.name || 'attachment.pdf', file_data: dataUrl(part) } };
  return { type: 'text', text: part.text };
}

function openAiMessages(request) {
  const messages = [];
  if (request.system) messages.push({ role: 'system', content: request.system });
  request.messages.forEach(({ role, content }) => {
    // Text-only turns go as a plain string: every OpenAI-compatible server accepts that,
    // not all of them accept the array form.
    const textOnly = content.every((part) => part.type === 'text');
    messages.push({
      role,
      content: textOnly ? content.map((part) => part.text).join('\n\n') : content.map(openAiPart),
    });
  });
  return messages;
}

function openAiUrl(endpoint) {
  const base = trimSlashes(endpoint);
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function azureUrl(connection) {
  const url = new URL(endpointOf(connection));
  const path = trimSlashes(url.pathname);
  const apiVersion = connection.apiVersion || PROVIDERS['azure-openai'].apiVersion;

  // The v1 API takes the deployment as `model` in the body and needs no api-version.
  if (/\/openai\/v1$/i.test(path)) {
    url.pathname = `${path}/chat/completions`;
    return url.href;
  }
  if (!/\/chat\/completions$/i.test(path)) {
    url.pathname = `/openai/deployments/${encodeURIComponent(connection.model)}/chat/completions`;
  }
  if (!url.searchParams.has('api-version')) url.searchParams.set('api-version', apiVersion);
  return url.href;
}

function buildOpenAi(connection, request) {
  const headers = { 'Content-Type': 'application/json' };
  const body = { model: connection.model, messages: openAiMessages(request) };
  let url;

  if (connection.provider === 'azure-openai') {
    url = azureUrl(connection);
    headers['api-key'] = connection.apiKey;
  } else {
    url = openAiUrl(endpointOf(connection));
    if (connection.apiKey) {
      if (connection.provider === 'openai-compatible' && connection.keyHeader
        && connection.keyHeader.toLowerCase() !== 'authorization') {
        headers[connection.keyHeader] = connection.apiKey;
      } else {
        headers.Authorization = `Bearer ${connection.apiKey}`;
      }
    }
  }

  if (request.maxTokens) {
    // OpenAI's current models reject max_tokens; compatible servers know nothing else.
    const key = connection.provider === 'openai-compatible' ? 'max_tokens' : 'max_completion_tokens';
    body[key] = request.maxTokens;
  }
  return { url, headers, body };
}

function parseOpenAi(json) {
  const choice = json.choices?.[0];
  const message = choice?.message;
  if (message?.refusal) throw new LlmError('blocked', `The model declined: ${message.refusal}`);
  if (choice?.finish_reason === 'content_filter') {
    throw new LlmError('blocked', 'The provider\'s content filter blocked this response.');
  }
  const { content } = message || {};
  const text = Array.isArray(content)
    ? content.map((part) => part.text || '').join('')
    : content;
  return {
    text,
    model: json.model,
    truncated: choice?.finish_reason === 'length',
    usage: json.usage && {
      inputTokens: json.usage.prompt_tokens,
      outputTokens: json.usage.completion_tokens,
    },
  };
}

/* ---------- Anthropic messages ---------- */

function anthropicPart(part) {
  if (part.type === 'image') {
    return { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } };
  }
  if (part.type === 'file') {
    return { type: 'document', source: { type: 'base64', media_type: part.mediaType, data: part.data } };
  }
  return { type: 'text', text: part.text };
}

function buildAnthropic(connection, request) {
  const base = trimSlashes(endpointOf(connection));
  let url = `${base}/v1/messages`;
  if (/\/messages$/i.test(base)) url = base;
  else if (/\/v1$/i.test(base)) url = `${base}/messages`;

  const body = {
    model: connection.model,
    max_tokens: request.maxTokens || ANTHROPIC_MAX_TOKENS,
    messages: request.messages.map(({ role, content }) => ({ role, content: content.map(anthropicPart) })),
  };
  if (request.system) body.system = request.system;

  return {
    url,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': connection.apiKey,
      'anthropic-version': connection.apiVersion || ANTHROPIC_VERSION,
      // Anthropic only answers browser (CORS) requests that carry this header.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body,
  };
}

function parseAnthropic(json) {
  if (json.stop_reason === 'refusal') throw new LlmError('blocked', 'The model declined this request.');
  const text = (json.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return {
    text,
    model: json.model,
    truncated: json.stop_reason === 'max_tokens',
    usage: json.usage && {
      inputTokens: json.usage.input_tokens,
      outputTokens: json.usage.output_tokens,
    },
  };
}

/* ---------- Google Gemini generateContent ---------- */

function geminiPart(part) {
  if (part.type === 'text') return { text: part.text };
  return { inlineData: { mimeType: part.mediaType, data: part.data } };
}

function buildGemini(connection, request) {
  let base = trimSlashes(endpointOf(connection));
  if (!/\/v\d+[a-z0-9]*$/i.test(base)) base = `${base}/v1beta`;
  const model = connection.model.replace(/^models\//, '');

  const body = {
    contents: request.messages.map(({ role, content }) => ({
      role: role === 'assistant' ? 'model' : 'user',
      parts: content.map(geminiPart),
    })),
  };
  if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
  if (request.maxTokens) body.generationConfig = { maxOutputTokens: request.maxTokens };

  return {
    url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': connection.apiKey },
    body,
  };
}

function parseGemini(json) {
  if (json.promptFeedback?.blockReason) {
    throw new LlmError('blocked', `Gemini blocked this request (${json.promptFeedback.blockReason}).`);
  }
  const candidate = json.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((part) => part.text || '').join('');
  if (!text && candidate?.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
    throw new LlmError('blocked', `Gemini stopped without an answer (${candidate.finishReason}).`);
  }
  return {
    text,
    model: json.modelVersion,
    truncated: candidate?.finishReason === 'MAX_TOKENS',
    usage: json.usageMetadata && {
      inputTokens: json.usageMetadata.promptTokenCount,
      outputTokens: json.usageMetadata.candidatesTokenCount,
    },
  };
}

/* ---------- Dispatch ---------- */

const ADAPTERS = {
  openai: { build: buildOpenAi, parse: parseOpenAi },
  'azure-openai': { build: buildOpenAi, parse: parseOpenAi },
  'openai-compatible': { build: buildOpenAi, parse: parseOpenAi },
  anthropic: { build: buildAnthropic, parse: parseAnthropic },
  gemini: { build: buildGemini, parse: parseGemini },
};

function adapterFor(connection) {
  const adapter = ADAPTERS[connection?.provider];
  if (!adapter) throw new LlmError('invalid', `Unknown provider "${connection?.provider}".`);
  return adapter;
}

/** @returns {{ url: string, headers: Object<string,string>, body: string }} */
export function buildRequest(connection, request) {
  const adapter = adapterFor(connection);
  if (!connection.model) throw new LlmError('invalid', 'This connection has no model name.');
  if (!request?.messages?.length) throw new LlmError('invalid', 'There is nothing to send.');
  assertSupported(connection, request);
  const { url, headers, body } = adapter.build(connection, request);
  return { url, headers, body: JSON.stringify(body) };
}

export function parseResponse(connection, json) {
  const result = adapterFor(connection).parse(json);
  if (typeof result.text !== 'string' || !result.text.trim()) {
    throw new LlmError('bad-response', 'The model returned an empty response. Try again or rephrase the request.');
  }
  return { ...result, model: result.model || connection.model };
}

// OpenAI and Gemini nest the message under `error`; Anthropic does too; some gateways use
// `message` or `detail` at the top level.
function upstreamMessage(json, text) {
  const error = json?.error;
  const message = (typeof error === 'string' ? error : error?.message)
    || json?.message
    || (typeof json?.detail === 'string' ? json.detail : '');
  return String(message || text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function httpError(status, json, text) {
  const detail = upstreamMessage(json, text);
  const suffix = detail ? ` The provider said: ${detail}` : '';
  // Gemini answers a wrong key with 400 and the reason API_KEY_INVALID.
  const keyRejected = status === 400 && /API_KEY_INVALID|API key not valid/i.test(text || '');
  if (status === 401 || status === 403 || keyRejected) {
    return new LlmError('auth', `The LLM rejected the credentials (${status}). Check the API key in the settings.${suffix}`, status);
  }
  if (status === 404) {
    return new LlmError('not-found', `The LLM endpoint or model was not found (404). Check the endpoint URL and model name in the settings.${suffix}`, status);
  }
  if (status === 429) {
    return new LlmError('rate-limit', `The LLM is rate limiting requests or the quota is used up (429). Try again shortly.${suffix}`, status);
  }
  if (status === 413) {
    return new LlmError('invalid', 'The request is too large for the LLM (413). Remove an attachment or select less content.', status);
  }
  return new LlmError('upstream', `The LLM returned an error (${status}).${suffix}`, status);
}

/**
 * Sends a neutral request to the connection's provider.
 * @param {object} connection A normalized connection from the configuration.
 * @param {object} request A neutral request (see the top of this file).
 * @param {object} [options]
 * @param {Function} [options.fetch] Defaults to the global fetch.
 * @param {AbortSignal} [options.signal]
 * @param {object} [options.fetchOptions] Extra fetch init, e.g. `{ redirect: 'error' }`.
 * @returns {Promise<{ text: string, model: string, truncated: boolean, usage?: object }>}
 */
export async function callLlm(connection, request, options = {}) {
  const { fetch = globalThis.fetch, signal, fetchOptions = {} } = options;
  const { url, headers, body } = buildRequest(connection, request);

  let resp;
  try {
    resp = await fetch(url, { ...fetchOptions, method: 'POST', headers, body, signal });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw new LlmError('aborted', 'Cancelled.');
    const { host } = new URL(url);
    throw new LlmError('network', `Could not reach ${host}.`);
  }

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  if (!resp.ok) throw httpError(resp.status, json, text);
  if (!json || typeof json !== 'object') {
    throw new LlmError('bad-response', 'The LLM endpoint did not return JSON. Check the endpoint URL in the settings.');
  }
  return parseResponse(connection, json);
}
