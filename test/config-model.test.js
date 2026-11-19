import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, emptyConfig, findConnection, getDefaultConnection, maskKey, normalizeConnection,
  parseSheet, toSheet, validateConnection, validateEndpoint, validateSettings,
} from '../tools/byo-llm/lib/config-model.js';

const connection = (overrides = {}) => normalizeConnection({
  name: 'Team GPT', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-secret-1234', ...overrides,
});

test('a configuration survives the round trip through sheet JSON', () => {
  const config = {
    connections: [
      connection(),
      connection({ name: 'Gateway', provider: 'openai-compatible', endpoint: 'https://llm.example.com/v1', apiKey: '', keyHeader: 'x-api-key' }),
    ],
    settings: { default: 'Gateway', brandGuidelines: 'Be brief.\nBe kind.', proxyUrl: 'https://proxy.example.com/generate' },
  };
  assert.deepEqual(parseSheet(JSON.parse(JSON.stringify(toSheet(config)))), config);
});

test('credentials are only written to private tabs', () => {
  const sheet = toSheet({ connections: [connection()], settings: emptyConfig().settings });
  const { ':private': privateTabs, ...publicPart } = sheet;
  assert.ok(!JSON.stringify(publicPart).includes('sk-secret-1234'));
  assert.equal(publicPart[':type'], 'sheet');
  assert.deepEqual(Object.keys(privateTabs), ['private-connections', 'private-settings']);
  assert.equal(privateTabs['private-connections'].data[0].apiKey, 'sk-secret-1234');
  assert.equal(privateTabs['private-connections'].total, 1);
});

test('parseSheet reads hand-made sheets and ignores junk', () => {
  // Public tabs created in the sheet editor.
  const multi = parseSheet({
    ':type': 'multi-sheet',
    ':names': ['connections', 'settings'],
    connections: { data: [{ name: 'A', provider: 'Anthropic', model: 'claude', apiKey: ' k ' }, { name: '', provider: 'openai' }] },
    settings: { data: [{ key: 'default', value: 'A' }, { key: 'unknown', value: 'x' }] },
  });
  assert.equal(multi.connections.length, 1);
  assert.equal(multi.connections[0].provider, 'anthropic');
  assert.equal(multi.connections[0].apiKey, 'k');
  assert.deepEqual(multi.settings, { default: 'A', brandGuidelines: '', proxyUrl: '' });

  // One key/value tab describing a single connection.
  const flat = parseSheet({ data: [{ key: 'provider', value: 'gemini' }, { key: 'model', value: 'gemini-2.5-flash' }, { key: 'apiKey', value: 'g' }] });
  assert.equal(flat.connections[0].name, 'Default');
  assert.equal(flat.connections[0].provider, 'gemini');

  for (const junk of [null, undefined, 'text', 42, {}, { data: 'nope' }, { ':private': {} }]) {
    assert.deepEqual(parseSheet(junk), emptyConfig());
  }
});

test('validateConnection reports each problem on its field', () => {
  assert.deepEqual(validateConnection(connection()), {});
  assert.deepEqual(Object.keys(validateConnection(normalizeConnection({ provider: 'openai' }))), ['name', 'model', 'apiKey']);
  assert.ok(validateConnection(connection({ provider: 'nope' })).provider);
  assert.ok(validateConnection(connection(), { otherNames: ['team gpt'] }).name);
  assert.ok(validateConnection(connection({ name: 'x'.repeat(61) })).name);
  // Azure and compatible endpoints have no default, so the URL is required.
  assert.ok(validateConnection(connection({ provider: 'azure-openai' })).endpoint);
  // A local model needs no key.
  assert.deepEqual(validateConnection(connection({ provider: 'openai-compatible', endpoint: 'http://localhost:11434/v1', apiKey: '' })), {});
  assert.ok(validateConnection(connection({ provider: 'openai-compatible', endpoint: 'https://x.example/v1', keyHeader: 'bad header' })).keyHeader);
});

test('validateEndpoint only accepts https, or http on this machine', () => {
  assert.equal(validateEndpoint('https://api.openai.com/v1'), null);
  assert.equal(validateEndpoint('http://localhost:11434/v1'), null);
  assert.equal(validateEndpoint('http://127.0.0.1:8080'), null);
  assert.ok(validateEndpoint('http://llm.internal/v1'));
  assert.ok(validateEndpoint('http://localhost:1234', { allowLocalHttp: false }));
  assert.ok(validateEndpoint('api.openai.com/v1'));
  assert.ok(validateEndpoint('javascript:alert(1)'));
  assert.ok(validateEndpoint('https://user:pass@example.com/v1'));
  assert.ok(validateSettings({ proxyUrl: 'ftp://x' }).proxyUrl);
  assert.deepEqual(validateSettings({ proxyUrl: '' }), {});
});

test('the default connection falls back to the first one', () => {
  const config = { connections: [connection({ name: 'A' }), connection({ name: 'B' })], settings: { default: 'B' } };
  assert.equal(getDefaultConnection(config).name, 'B');
  assert.equal(getDefaultConnection({ ...config, settings: { default: 'Gone' } }).name, 'A');
  assert.equal(getDefaultConnection(emptyConfig()), undefined);
  assert.equal(findConnection(config, ''), undefined);
});

test('maskKey never shows more than the last four characters', () => {
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('short'), '••••••••');
  assert.equal(maskKey('sk-secret-1234'), '••••••••1234');
});

test('every provider is fully described', () => {
  for (const [id, info] of Object.entries(PROVIDERS)) {
    assert.ok(info.label && info.endpointHint && info.modelHint, id);
    assert.equal(typeof info.images, 'boolean', id);
    assert.equal(typeof info.pdf, 'boolean', id);
    if (info.endpoint) assert.equal(validateEndpoint(info.endpoint), null, id);
  }
});
