import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyConfig, normalizeConnection, toSheet } from '../tools/byo-llm/lib/config-model.js';
import { DEFAULT_ORIGINS, createAuthedFetch, createStore } from '../tools/byo-llm/lib/store.js';

const config = {
  connections: [normalizeConnection({ name: 'A', provider: 'openai', model: 'm', apiKey: 'k' })],
  settings: { default: 'A', brandGuidelines: '', proxyUrl: '' },
};

/** A fake DA: records requests and answers from a list of [matcher, response] routes. */
function fakeNetwork(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const route = routes.find(([matcher]) => url.includes(matcher));
    if (!route) throw new TypeError('Failed to fetch');
    return typeof route[1] === 'function' ? route[1](init) : route[1];
  };
  return { fetch, calls };
}

const json = (body, init) => new Response(JSON.stringify(body), init);
const classicPing = ['/ping/', new Response('ok')];
const upgradedPing = ['/ping/', new Response('ok', { headers: { 'x-api-upgrade-available': 'true' } })];

test('load reads the sheet from DA admin and reports write permission', async () => {
  const { fetch, calls } = fakeNetwork([
    classicPing,
    ['/source/', json(toSheet(config), { headers: { 'x-da-actions': '/acme/site/.da/byo-llm.json=read,write' } })],
  ]);
  const store = createStore({ org: 'acme', site: 'site', fetch, plainFetch: fetch });
  assert.deepEqual(await store.load(), { exists: true, config, canWrite: true });
  assert.equal(calls[0].url, 'https://admin.hlx.page/ping/acme/site');
  assert.equal(calls[1].url, 'https://admin.da.live/source/acme/site/.da/byo-llm.json');
  assert.equal(store.path, '/acme/site/.da/byo-llm');
});

test('a missing sheet is an empty configuration, not an error', async () => {
  const { fetch } = fakeNetwork([classicPing, ['/source/', new Response('', { status: 404, headers: { 'x-da-actions': '/x=read' } })]]);
  const store = createStore({ org: 'acme', site: 'site', fetch, plainFetch: fetch });
  assert.deepEqual(await store.load(), { exists: false, config: emptyConfig(), canWrite: false });
});

test('load failures carry a code the UI can act on', async () => {
  const load = (routes) => {
    const { fetch } = fakeNetwork(routes);
    return createStore({ org: 'acme', site: 'site', fetch, plainFetch: fetch }).load();
  };
  await assert.rejects(load([classicPing, ['/source/', new Response('', { status: 401 })]]), { code: 'unauthenticated' });
  await assert.rejects(load([classicPing, ['/source/', new Response('', { status: 403 })]]), { code: 'forbidden' });
  await assert.rejects(load([classicPing, ['/source/', new Response('', { status: 500 })]]), { code: 'failed', status: 500 });
  await assert.rejects(load([classicPing, ['/source/', new Response('not json')]]), { code: 'failed' });
  await assert.rejects(load([classicPing]), { code: 'network' });
});

test('save posts the sheet to DA admin as a multipart form', async () => {
  const { fetch, calls } = fakeNetwork([classicPing, ['/source/', new Response('', { status: 201 })]]);
  await createStore({ org: 'acme', site: 'site', fetch, plainFetch: fetch }).save(config);
  const { url, init } = calls.at(-1);
  assert.equal(url, 'https://admin.da.live/source/acme/site/.da/byo-llm.json');
  assert.equal(init.method, 'POST');
  assert.ok(init.body instanceof FormData);
  const blob = init.body.get('data');
  assert.equal(blob.type, 'application/json');
  assert.deepEqual(JSON.parse(await blob.text()), toSheet(config));
});

test('upgraded sites use the AEM API and a JSON body', async () => {
  const { fetch, calls } = fakeNetwork([upgradedPing, ['/source/', () => json(toSheet(config))]]);
  const store = createStore({ org: 'acme', site: 'site', fetch, plainFetch: fetch });
  await store.load();
  await store.save(config);
  assert.equal(calls[1].url, 'https://api.aem.live/acme/sites/site/source/.da/byo-llm.json');
  const { init } = calls.at(-1);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), toSheet(config));
  // The upgrade check runs once, not per request.
  assert.equal(calls.filter(({ url }) => url.includes('/ping/')).length, 1);
});

test('a failed upgrade check falls back to DA admin', async () => {
  const { fetch, calls } = fakeNetwork([['/source/', json(toSheet(config))]]);
  await createStore({ org: 'acme', site: 'site', fetch, plainFetch: fetch }).load();
  assert.ok(calls.at(-1).url.startsWith('https://admin.da.live/source/'));
});

test('save failures are reported', async () => {
  const save = (status) => {
    const { fetch } = fakeNetwork([classicPing, ['/source/', new Response('', { status })]]);
    return createStore({ org: 'acme', site: 'site', fetch, plainFetch: fetch }).save(config);
  };
  await assert.rejects(save(403), { code: 'forbidden', message: /permission to change/ });
  await assert.rejects(save(401), { code: 'unauthenticated' });
  await assert.rejects(save(500), { code: 'failed' });
});

test('the store needs an org and a site', () => {
  assert.throws(() => createStore({ org: 'acme', site: '', fetch }), { code: 'failed' });
});

test('createAuthedFetch adds the current token, and the content-source header for AEM APIs', async () => {
  const seen = [];
  let token = 'one';
  const authed = createAuthedFetch(() => token, { fetch: async (url, init) => { seen.push(init.headers); return new Response(''); } });

  await authed(`${DEFAULT_ORIGINS.daAdmin}/source/a/b/c.json`, { headers: { Accept: 'application/json' } });
  assert.deepEqual(seen[0], { Accept: 'application/json', Authorization: 'Bearer one' });

  token = 'two';
  await authed(`${DEFAULT_ORIGINS.aemApi}/a/sites/b/source/c.json`);
  assert.deepEqual(seen[1], { Authorization: 'Bearer two', 'x-content-source-authorization': 'Bearer two' });

  token = '';
  await authed(`${DEFAULT_ORIGINS.daAdmin}/source/a/b/c.json`);
  assert.deepEqual(seen[2], {});
});
