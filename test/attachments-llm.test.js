import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCEPT, MAX_FILES, MAX_TEXT_BYTES, MAX_TEXT_CHARS, checkFile, classify, formatBytes, readAttachment,
} from '../tools/byo-llm/lib/attachments.js';
import { normalizeConnection } from '../tools/byo-llm/lib/config-model.js';
import { PROXY_MAX_BYTES, generate } from '../tools/byo-llm/lib/llm.js';

/* ---------- attachments.js ---------- */

test('files are classified by type, then by extension', () => {
  assert.equal(classify({ name: 'notes.txt', type: 'text/plain' }), 'text');
  assert.equal(classify({ name: 'README.md', type: '' }), 'text');
  assert.equal(classify({ name: 'data.json', type: 'application/json' }), 'text');
  assert.equal(classify({ name: 'photo.JPG', type: '' }), 'image');
  assert.equal(classify({ name: 'photo', type: 'image/webp' }), 'image');
  assert.equal(classify({ name: 'doc.pdf', type: '' }), 'pdf');
  assert.equal(classify({ name: 'x', type: 'application/pdf' }), 'pdf');
  for (const file of [
    { name: 'a.zip', type: 'application/zip' },
    { name: 'a.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { name: 'a.svg', type: 'image/svg+xml' },
    { name: 'noextension', type: '' },
  ]) assert.equal(classify(file), 'unsupported', file.name);
  assert.ok(ACCEPT.split(',').includes('.pdf'));
});

test('checkFile enforces the count, type and size limits', () => {
  assert.deepEqual(checkFile({ name: 'a.txt', type: 'text/plain', size: 10 }), { kind: 'text' });
  assert.match(checkFile({ name: 'a.txt', type: 'text/plain', size: 10 }, { count: MAX_FILES }).error, /up to 5 files/);
  assert.match(checkFile({ name: 'a.zip', type: 'application/zip', size: 10 }).error, /can't be attached/);
  assert.match(checkFile({ name: 'a.txt', type: 'text/plain', size: 0 }).error, /is empty/);
  assert.match(checkFile({ name: 'a.txt', type: 'text/plain', size: MAX_TEXT_BYTES + 1 }).error, /too large .*1\.0 MB/);
  assert.deepEqual(checkFile({ name: 'a.png', type: 'image/png', size: MAX_TEXT_BYTES + 1 }), { kind: 'image' });
});

test('formatBytes is readable', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});

test('text files are read as text, and very long ones are cut', async () => {
  const short = await readAttachment(new File(['héllo'], 'a.txt', { type: 'text/plain' }), 'text');
  assert.deepEqual(short, {
    kind: 'text', name: 'a.txt', size: 5, text: 'héllo', truncated: false,
  });
  const long = await readAttachment(new File(['x'.repeat(MAX_TEXT_CHARS + 10)], 'b.txt'), 'text');
  assert.equal(long.text.length, MAX_TEXT_CHARS);
  assert.equal(long.truncated, true);
});

/* ---------- llm.js ---------- */

const connection = normalizeConnection({ name: 'Team GPT', provider: 'openai', model: 'm', apiKey: 'sk-secret' });
const request = { system: 'S', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] };
const context = { org: 'acme', site: 'site' };
const settings = (proxyUrl = '') => ({ connections: [connection], settings: { default: '', brandGuidelines: '', proxyUrl } });
const PROXY = 'https://runtime.example.net/api/v1/web/byo-llm/generate';

test('without a proxy the browser calls the LLM, and the IMS token stays home', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Answer' } }] }));
  };
  const result = await generate({
    config: settings(), connection, request, context, token: 'ims-token', fetch,
  });
  assert.equal(result.text, 'Answer');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.ok(!JSON.stringify(calls[0].init).includes('ims-token'));
});

test('with a proxy the request names the connection, and the API key stays home', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ text: 'Answer', model: 'm', truncated: false }));
  };
  const result = await generate({
    config: settings(PROXY), connection, request, context, token: 'ims-token', fetch,
  });
  assert.equal(result.text, 'Answer');
  assert.equal(calls[0].url, PROXY);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ims-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    org: 'acme', site: 'site', connection: 'Team GPT', request,
  });
  assert.ok(!calls[0].init.body.includes('sk-secret'));
});

test('proxy errors keep their code and message', async () => {
  const viaProxy = (response) => generate({
    config: settings(PROXY), connection, request, context, token: 't', fetch: async () => response,
  });
  await assert.rejects(
    viaProxy(new Response(JSON.stringify({ error: 'Not for this org.', code: 'auth' }), { status: 403 })),
    { code: 'auth', message: 'Not for this org.', status: 403 },
  );
  await assert.rejects(viaProxy(new Response('<html>502</html>', { status: 502 })), { code: 'upstream', message: /\(502\)/ });
  await assert.rejects(viaProxy(new Response(JSON.stringify({ text: '' }))), { code: 'bad-response' });
  await assert.rejects(generate({
    config: settings(PROXY), connection, request, context, token: 't', fetch: async () => { throw new TypeError('Failed to fetch'); },
  }), { code: 'network', message: /proxy/ });
});

test('a request too large for the proxy is refused before it is sent', async () => {
  let called = false;
  const big = { ...request, messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'A'.repeat(PROXY_MAX_BYTES) }] }] };
  await assert.rejects(generate({
    config: settings(PROXY), connection, request: big, context, token: 't', fetch: async () => { called = true; },
  }), { code: 'invalid', message: /too large/ });
  assert.equal(called, false);
});

test('a direct network failure points at CORS and the proxy', async () => {
  await assert.rejects(generate({
    config: settings(), connection, request, context, token: 't', fetch: async () => { throw new TypeError('Failed to fetch'); },
  }), { code: 'network', message: /api\.openai\.com.*proxy/s });
});
