import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertPublicEndpoint, createMain, isPrivateAddress, readRequest,
} from '../actions/generate/index.js';
import { getBearerToken, isAllowed, parseAllowList } from '../lib/utils.js';
import { normalizeConnection, toSheet } from '../../plugin/tools/byo-llm/lib/config-model.js';

const TOKEN = 'ims-token';
const KEY = 'sk-secret-1234';
const request = { system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] };

const sheet = toSheet({
  connections: [
    normalizeConnection({ name: 'Team GPT', provider: 'openai', model: 'gpt-x', apiKey: KEY }),
    normalizeConnection({ name: 'Internal', provider: 'openai-compatible', endpoint: 'https://llm.corp.example/v1', model: 'm' }),
    normalizeConnection({ name: 'Local', provider: 'openai-compatible', endpoint: 'http://localhost:11434/v1', model: 'm' }),
  ],
  settings: { default: 'Team GPT', brandGuidelines: '', proxyUrl: '' },
});

/** DA, the LLM and DNS, faked. `calls` records every outgoing request. */
function setup({ daStatus = 200, llm, addresses = { 'api.openai.com': '104.18.7.192', 'llm.corp.example': '10.0.0.5' } } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes('/ping/')) return new Response('ok');
    if (url.startsWith('https://admin.da.live/source/')) {
      if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return new Response('', { status: 401 });
      return daStatus === 200 ? new Response(JSON.stringify(sheet)) : new Response('', { status: daStatus });
    }
    if (llm) return llm(url, init);
    return new Response(JSON.stringify({ model: 'gpt-x', choices: [{ message: { content: '<p>Answer</p>' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }));
  };
  const lookup = async (host) => {
    if (!addresses[host]) throw new Error('ENOTFOUND');
    return [{ address: addresses[host], family: 4 }];
  };
  return { main: createMain({ fetch, lookup }), calls, llmCalls: () => calls.filter(({ url }) => !url.includes('da.live') && !url.includes('hlx.page')) };
}

const params = (overrides = {}) => ({
  BYO_LLM_ALLOWED_ORGS: 'acme',
  __ow_method: 'post',
  __ow_headers: { authorization: `Bearer ${TOKEN}` },
  org: 'acme',
  site: 'site',
  connection: 'Team GPT',
  request,
  ...overrides,
});

test('a valid request is answered through the configured connection', async () => {
  const { main, llmCalls } = setup();
  const result = await main(params());
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    text: '<p>Answer</p>', model: 'gpt-x', truncated: false, usage: { inputTokens: 1, outputTokens: 2 },
  });
  const [call] = llmCalls();
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(call.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(call.init.redirect, 'error');
  // The caller's Experience Workspace token goes to DA only.
  assert.ok(!JSON.stringify(call.init).includes(TOKEN));
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('the allow list is required and exact', async () => {
  const { main, calls } = setup();
  assert.equal((await main(params({ BYO_LLM_ALLOWED_ORGS: undefined }))).statusCode, 500);
  assert.equal((await main(params({ BYO_LLM_ALLOWED_ORGS: ' , ' }))).statusCode, 500);
  // What the action would get if the variable was never substituted at deploy time.
  assert.equal((await main(params({ BYO_LLM_ALLOWED_ORGS: '$BYO_LLM_ALLOWED_ORGS' }))).statusCode, 403);
  assert.equal((await main(params({ org: 'other' }))).statusCode, 403);
  assert.equal((await main(params({ BYO_LLM_ALLOWED_ORGS: 'acme/other-site' }))).statusCode, 403);
  assert.equal((await main(params({ BYO_LLM_ALLOWED_ORGS: '*' }))).statusCode, 403);
  // Nothing was fetched for any of these.
  assert.equal(calls.length, 0);

  assert.equal((await main(params({ BYO_LLM_ALLOWED_ORGS: 'x, ACME/Site' }))).statusCode, 200);
});

test('callers must present a token that DA accepts for the site', async () => {
  const missing = setup();
  assert.equal((await missing.main(params({ __ow_headers: {} }))).statusCode, 401);
  assert.equal(missing.calls.length, 0);

  const wrong = setup();
  const rejected = await wrong.main(params({ __ow_headers: { authorization: 'Bearer someone-else' } }));
  assert.equal(rejected.statusCode, 401);
  assert.equal(rejected.body.code, 'auth');
  assert.equal(wrong.llmCalls().length, 0);

  const forbidden = setup({ daStatus: 403 });
  assert.equal((await forbidden.main(params())).statusCode, 403);
  assert.equal(forbidden.llmCalls().length, 0);

  const broken = setup({ daStatus: 500 });
  assert.equal((await broken.main(params())).statusCode, 502);
});

test('malformed requests are rejected', async () => {
  const { main, llmCalls } = setup();
  const status = async (overrides) => (await main(params(overrides))).statusCode;
  assert.equal(await status({ __ow_method: 'get' }), 405);
  assert.equal(await status({ org: '../etc' }), 400);
  assert.equal(await status({ org: 'acme', site: 'a/b' }), 400);
  assert.equal(await status({ site: undefined }), 400);
  assert.equal(await status({ connection: '' }), 400);
  assert.equal(await status({ connection: 'Nope' }), 404);
  assert.equal(await status({ request: undefined }), 400);
  assert.equal(await status({ request: { messages: [] } }), 400);
  assert.equal(await status({ request: { messages: [{ role: 'system', content: [{ type: 'text', text: 'x' }] }] } }), 400);
  assert.equal(await status({ request: { messages: [{ role: 'user', content: [{ type: 'tool', text: 'x' }] }] } }), 400);
  assert.equal(await status({ request: { messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'not base64!' }] }] } }), 400);
  assert.equal(llmCalls().length, 0);
});

test('request parameters cannot swap in another endpoint or key', async () => {
  const { main, llmCalls } = setup();
  const result = await main(params({
    endpoint: 'https://evil.example/v1',
    apiKey: 'attacker',
    request: { ...request, model: 'other', url: 'https://evil.example', extra: { nested: true } },
  }));
  assert.equal(result.statusCode, 200);
  const [call] = llmCalls();
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
  assert.deepEqual(JSON.parse(call.init.body), {
    model: 'gpt-x',
    messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'Hi' }],
  });
});

test('endpoints that are not public https are never called', async () => {
  const { main, llmCalls } = setup();
  const internal = await main(params({ connection: 'Internal' }));
  assert.equal(internal.statusCode, 400);
  assert.match(internal.body.error, /public internet/);
  const local = await main(params({ connection: 'Local' }));
  assert.equal(local.statusCode, 400);
  assert.match(local.body.error, /https/);
  assert.equal(llmCalls().length, 0);
});

test('LLM failures come back with their code and without secrets', async () => {
  const failing = async (llm) => {
    const result = await setup({ llm }).main(params());
    assert.ok(!JSON.stringify(result).includes(KEY));
    return result;
  };
  const auth = await failing(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }));
  assert.equal(auth.statusCode, 502);
  assert.equal(auth.body.code, 'auth');

  const limited = await failing(async () => new Response('{}', { status: 429 }));
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.body.code, 'rate-limit');

  const down = await failing(async () => { throw new TypeError('fetch failed'); });
  assert.equal(down.statusCode, 502);
  assert.equal(down.body.code, 'network');

  const timeout = await failing(async () => { throw new DOMException('timed out', 'AbortError'); });
  assert.equal(timeout.statusCode, 504);
});

test('readRequest copies only the documented shape', () => {
  assert.deepEqual(readRequest({
    system: 'S',
    maxTokens: 100,
    temperature: 2,
    messages: [{ role: 'user', extra: 1, content: [{ type: 'text', text: 'a', cache: true }, { type: 'file', mediaType: 'application/pdf', data: 'QUJD', name: 'a.pdf' }] }],
  }), {
    system: 'S',
    maxTokens: 100,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'file', mediaType: 'application/pdf', data: 'QUJD', name: 'a.pdf' }] }],
  });
  assert.equal(readRequest({ system: 5, messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }] }), null);
  assert.equal(readRequest({ messages: Array.from({ length: 41 }, () => ({ role: 'user', content: [{ type: 'text', text: 'a' }] })) }), null);
  assert.equal(readRequest('nope'), null);
});

test('private and reserved addresses are recognised', async () => {
  for (const address of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1', 'not-an-ip']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '104.18.7.192', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(address), false, address);
  }

  const lookup = async () => [{ address: '8.8.8.8' }, { address: '10.0.0.1' }];
  await assert.rejects(assertPublicEndpoint('https://mixed.example/v1', lookup), { code: 'invalid' });
  await assert.rejects(assertPublicEndpoint('https://169.254.169.254/latest', lookup), { code: 'invalid' });
  await assert.rejects(assertPublicEndpoint('https://[::1]/v1', lookup), { code: 'invalid' });
  await assert.rejects(assertPublicEndpoint('http://example.com/v1', lookup), { code: 'invalid' });
  await assert.rejects(assertPublicEndpoint('nope', lookup), { code: 'invalid' });
  await assert.rejects(assertPublicEndpoint('https://gone.example/v1', async () => { throw new Error('ENOTFOUND'); }), { code: 'network' });
  await assertPublicEndpoint('https://ok.example/v1', async () => [{ address: '8.8.8.8' }]);
});

test('action helpers', () => {
  assert.equal(getBearerToken({ __ow_headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(getBearerToken({ __ow_headers: { authorization: 'Basic abc' } }), undefined);
  assert.equal(getBearerToken({}), undefined);
  assert.deepEqual(parseAllowList(' Acme, other/Site ,, '), ['acme', 'other/site']);
  assert.deepEqual(parseAllowList(undefined), []);
  assert.equal(isAllowed(['acme'], 'ACME', 'any'), true);
  assert.equal(isAllowed(['acme/site'], 'acme', 'other'), false);
});

test('the deployed action cannot be reconfigured by a request', async () => {
  const manifest = await readFile(new URL('../app.config.yaml', import.meta.url), 'utf8');
  assert.match(manifest, /^\s+final: true$/m);
  assert.match(manifest, /^\s+BYO_LLM_ALLOWED_ORGS: \$BYO_LLM_ALLOWED_ORGS$/m);
  assert.match(manifest, /^\s+web: 'yes'$/m);
});
