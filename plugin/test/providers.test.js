import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConnection } from '../tools/byo-llm/lib/config-model.js';
import {
  LlmError, buildRequest, callLlm, parseResponse,
} from '../tools/byo-llm/lib/providers.js';

const KEY = 'sk-secret-1234';
const conn = (overrides) => normalizeConnection({ name: 'C', model: 'm1', apiKey: KEY, ...overrides });
const text = (value) => ({ type: 'text', text: value });
const image = { type: 'image', mediaType: 'image/png', data: 'AAAA' };
const pdf = { type: 'file', mediaType: 'application/pdf', data: 'BBBB', name: 'a.pdf' };
const request = (content = [text('Hello')]) => ({ system: 'SYS', messages: [{ role: 'user', content }] });
const build = (connection, req = request()) => {
  const built = buildRequest(connection, req);
  return { ...built, body: JSON.parse(built.body) };
};

const respond = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('OpenAI: chat completions with a bearer key', () => {
  const { url, headers, body } = build(conn({ provider: 'openai' }));
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(body, {
    model: 'm1',
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'Hello' }],
  });
});

test('OpenAI: images and PDFs go as content parts, max tokens under the current name', () => {
  const { body } = build(conn({ provider: 'openai' }), { ...request([text('Look'), image, pdf]), maxTokens: 50 });
  assert.deepEqual(body.messages[1].content, [
    { type: 'text', text: 'Look' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,BBBB' } },
  ]);
  assert.equal(body.max_completion_tokens, 50);
  assert.equal(body.max_tokens, undefined);
});

test('OpenAI-compatible: endpoint variants, optional key, custom key header', () => {
  const base = { provider: 'openai-compatible' };
  assert.equal(build(conn({ ...base, endpoint: 'https://llm.example.com/v1/' })).url, 'https://llm.example.com/v1/chat/completions');
  assert.equal(build(conn({ ...base, endpoint: 'https://llm.example.com/v1/chat/completions' })).url, 'https://llm.example.com/v1/chat/completions');

  const local = build(conn({ ...base, endpoint: 'http://localhost:11434/v1', apiKey: '' }));
  assert.equal(local.headers.Authorization, undefined);

  const custom = build(conn({ ...base, endpoint: 'https://gw.example.com/v1', keyHeader: 'x-api-key' }), { ...request(), maxTokens: 9 });
  assert.equal(custom.headers['x-api-key'], KEY);
  assert.equal(custom.headers.Authorization, undefined);
  assert.equal(custom.body.max_tokens, 9);
});

test('Azure OpenAI: deployment URL, api-key header, api-version', () => {
  const azure = { provider: 'azure-openai', model: 'my deploy', endpoint: 'https://res.openai.azure.com/' };
  const classic = build(conn(azure));
  assert.equal(classic.url, 'https://res.openai.azure.com/openai/deployments/my%20deploy/chat/completions?api-version=2024-10-21');
  assert.equal(classic.headers['api-key'], KEY);
  assert.equal(classic.headers.Authorization, undefined);

  assert.match(build(conn({ ...azure, apiVersion: '2025-01-01-preview' })).url, /api-version=2025-01-01-preview$/);
  assert.equal(build(conn({ ...azure, endpoint: 'https://res.openai.azure.com/openai/v1' })).url, 'https://res.openai.azure.com/openai/v1/chat/completions');
  // A full URL pasted from the Azure portal is used as it is.
  const pasted = 'https://res.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-06-01';
  assert.equal(build(conn({ ...azure, endpoint: pasted })).url, pasted);
});

test('Anthropic: messages API with system, images and documents', () => {
  const { url, headers, body } = build(conn({ provider: 'anthropic' }), request([text('Look'), image, pdf]));
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(headers['x-api-key'], KEY);
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(body.system, 'SYS');
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'Look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' } },
  ]);
  assert.equal(build(conn({ provider: 'anthropic', endpoint: 'https://gw.example.com/anthropic/v1' })).url, 'https://gw.example.com/anthropic/v1/messages');
});

test('Gemini: generateContent with the key in a header, not the URL', () => {
  const req = { system: 'SYS', messages: [{ role: 'user', content: [text('Hi'), image] }, { role: 'assistant', content: [text('Yo')] }], maxTokens: 7 };
  const { url, headers, body } = build(conn({ provider: 'gemini', model: 'models/gemini-2.5-flash' }), req);
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.ok(!url.includes(KEY));
  assert.equal(headers['x-goog-api-key'], KEY);
  assert.deepEqual(body, {
    contents: [
      { role: 'user', parts: [{ text: 'Hi' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] },
      { role: 'model', parts: [{ text: 'Yo' }] },
    ],
    systemInstruction: { parts: [{ text: 'SYS' }] },
    generationConfig: { maxOutputTokens: 7 },
  });
  assert.equal(build(conn({ provider: 'gemini', endpoint: 'https://generativelanguage.googleapis.com' })).url, 'https://generativelanguage.googleapis.com/v1beta/models/m1:generateContent');
});

test('requests that cannot work are refused before anything is sent', () => {
  const code = (fn) => { try { fn(); } catch (error) { return error.code; } return 'no error'; };
  assert.equal(code(() => buildRequest(conn({ provider: 'nope' }), request())), 'invalid');
  assert.equal(code(() => buildRequest(conn({ provider: 'openai', model: '' }), request())), 'invalid');
  assert.equal(code(() => buildRequest(conn({ provider: 'openai' }), { messages: [] })), 'invalid');
  assert.equal(code(() => buildRequest(conn({ provider: 'azure-openai' }), request())), 'invalid');
  assert.equal(code(() => buildRequest(conn({ provider: 'azure-openai', endpoint: 'https://r.openai.azure.com' }), request([pdf]))), 'unsupported');
  assert.equal(code(() => buildRequest(conn({ provider: 'openai-compatible', endpoint: 'https://x.example/v1' }), request([pdf]))), 'unsupported');
});

test('responses are read per provider', () => {
  assert.deepEqual(parseResponse(conn({ provider: 'openai' }), {
    model: 'gpt-x', choices: [{ message: { content: '<p>Hi</p>' }, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 4 },
  }), {
    text: '<p>Hi</p>', model: 'gpt-x', truncated: true, usage: { inputTokens: 3, outputTokens: 4 },
  });

  const claude = parseResponse(conn({ provider: 'anthropic' }), {
    model: 'claude-x', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'A' }, { type: 'text', text: 'B' }], usage: { input_tokens: 1, output_tokens: 2 },
  });
  assert.equal(claude.text, 'AB');
  assert.equal(claude.truncated, false);

  const gemini = parseResponse(conn({ provider: 'gemini' }), {
    candidates: [{ content: { parts: [{ text: 'G' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6 },
  });
  assert.deepEqual(gemini, {
    text: 'G', model: 'm1', truncated: true, usage: { inputTokens: 5, outputTokens: 6 },
  });
});

test('refusals, filters and empty answers become errors', () => {
  const code = (connection, json) => { try { parseResponse(connection, json); } catch (error) { return error.code; } return 'no error'; };
  assert.equal(code(conn({ provider: 'openai' }), { choices: [{ message: { refusal: 'No.' } }] }), 'blocked');
  assert.equal(code(conn({ provider: 'openai' }), { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }), 'blocked');
  assert.equal(code(conn({ provider: 'anthropic' }), { stop_reason: 'refusal', content: [] }), 'blocked');
  assert.equal(code(conn({ provider: 'gemini' }), { promptFeedback: { blockReason: 'SAFETY' } }), 'blocked');
  assert.equal(code(conn({ provider: 'gemini' }), { candidates: [{ finishReason: 'SAFETY' }] }), 'blocked');
  assert.equal(code(conn({ provider: 'openai' }), { choices: [{ message: { content: '   ' } }] }), 'bad-response');
  assert.equal(code(conn({ provider: 'openai' }), {}), 'bad-response');
});

test('callLlm posts the built request and returns the answer', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ model: 'm1', choices: [{ message: { content: 'Done' }, finish_reason: 'stop' }] }));
  };
  const result = await callLlm(conn({ provider: 'openai' }), request(), { fetch, fetchOptions: { redirect: 'error' } });
  assert.equal(result.text, 'Done');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(JSON.parse(calls[0].init.body).model, 'm1');
});

test('HTTP and network failures map to codes, and never leak the key', async () => {
  const run = async (fetch) => {
    try {
      await callLlm(conn({ provider: 'openai' }), request(), { fetch });
    } catch (error) {
      assert.ok(error instanceof LlmError);
      assert.ok(!error.message.includes(KEY), error.message);
      return error;
    }
    return assert.fail('expected an error');
  };

  const auth = await run(respond(401, { error: { message: `Incorrect API key` } }));
  assert.equal(auth.code, 'auth');
  assert.equal(auth.status, 401);
  assert.match(auth.message, /Incorrect API key/);

  assert.equal((await run(respond(403, {}))).code, 'auth');
  // Gemini's answer to a wrong key, as the live API returns it.
  const gemini = await run(respond(400, {
    error: {
      code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }],
    },
  }));
  assert.equal(gemini.code, 'auth');
  assert.equal((await run(respond(400, { error: { message: 'Unknown field.' } }))).code, 'upstream');
  assert.equal((await run(respond(404, { error: 'model not found' }))).code, 'not-found');
  assert.equal((await run(respond(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }))).code, 'rate-limit');
  assert.equal((await run(respond(413, 'too big'))).code, 'invalid');
  assert.equal((await run(respond(500, '<html>Bad gateway</html>'))).code, 'upstream');
  assert.equal((await run(respond(200, '<html>login page</html>'))).code, 'bad-response');
  assert.equal((await run(async () => { throw new TypeError('Failed to fetch'); })).code, 'network');

  const long = await run(respond(500, { message: 'x'.repeat(2000) }));
  assert.ok(long.message.length < 400);
});

test('an aborted request is reported as cancelled, not as a network failure', async () => {
  const controller = new AbortController();
  const fetch = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  const pending = callLlm(conn({ provider: 'openai' }), request(), { fetch, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
});
