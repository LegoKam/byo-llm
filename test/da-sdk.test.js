import { test } from 'node:test';
import assert from 'node:assert/strict';

/*
 * The SDK client talks to its host with window messages and a MessagePort. Here the window is
 * a small stand-in and the port is a real one from Node, so the protocol itself is exercised.
 */

const parent = { name: 'host window' };
const listeners = [];
globalThis.window = { parent, addEventListener: (type, listener) => { if (type === 'message') listeners.push(listener); } };
globalThis.document = { title: 'BYO LLM' };
const deliver = (event) => listeners.forEach((listener) => listener(event));
const nextMessage = (port) => new Promise((resolve) => { port.once('message', resolve); });
const tick = () => new Promise((resolve) => { setTimeout(resolve, 20); });

const { default: DA_SDK } = await import('../tools/byo-llm/lib/da-sdk.js');
const channel = new MessageChannel();
const host = channel.port1;
host.setMaxListeners(50);
let sdk;

test('messages that are not the host handshake are ignored', async () => {
  let resolved = false;
  DA_SDK.then(() => { resolved = true; });

  // From another window, with everything else right.
  deliver({ source: { name: 'other frame' }, data: { ready: true, token: 'evil', context: { org: 'evil' } }, ports: [new MessageChannel().port2] });
  // From the host, but not a handshake (browser extensions post such things).
  deliver({ source: parent, data: { ready: true }, ports: [] });
  deliver({ source: parent, data: { token: 'early' }, ports: [] });
  deliver({ source: parent, data: null, ports: [] });
  await tick();
  assert.equal(resolved, false);
});

test('the handshake delivers context, token and actions', async () => {
  const title = nextMessage(host);
  // A fullscreen app gets `repo` but no `site`.
  deliver({ source: parent, data: { ready: true, token: 'token-1', context: { org: 'acme', repo: 'site-a', path: '/x' } }, ports: [channel.port2] });
  sdk = await DA_SDK;
  assert.deepEqual(sdk.context, { org: 'acme', repo: 'site-a', path: '/x', site: 'site-a' });
  assert.equal(sdk.getToken(), 'token-1');
  assert.deepEqual(await title, { action: 'setTitle', details: 'BYO LLM' });
});

test('a second handshake cannot replace the first, but the host can refresh the token', async () => {
  deliver({ source: parent, data: { ready: true, token: 'token-x', context: { org: 'other' } }, ports: [new MessageChannel().port2] });
  assert.equal((await DA_SDK).context.org, 'acme');

  deliver({ source: { name: 'other frame' }, data: { token: 'evil' }, ports: [] });
  assert.equal(sdk.getToken(), 'token-x');
  deliver({ source: parent, data: { token: 'token-2' }, ports: [] });
  assert.equal(sdk.getToken(), 'token-2');
});

test('insert actions are posted to the host', async () => {
  let message = nextMessage(host);
  sdk.actions.sendHTML('<p>Hi</p>');
  assert.deepEqual(await message, { action: 'sendHTML', details: '<p>Hi</p>' });

  message = nextMessage(host);
  sdk.actions.sendText('Hi');
  assert.deepEqual(await message, { action: 'sendText', details: 'Hi' });

  message = nextMessage(host);
  sdk.actions.closeLibrary();
  assert.deepEqual(await message, { action: 'closeLibrary' });
});

test('getSelection matches the answer to its request', async () => {
  const request = nextMessage(host);
  const pending = sdk.actions.getSelection();
  const { action, requestId } = await request;
  assert.equal(action, 'getSelection');
  assert.equal(typeof requestId, 'string');

  // An answer to some other request must not resolve this one.
  host.postMessage({ action: 'sdkResponse', requestId: 'someone-else', result: { ok: true, html: '<p>Wrong</p>' } });
  host.postMessage({ action: 'sdkResponse', requestId, result: { ok: true, html: '<p>Selected</p>' } });
  assert.equal(await pending, '<p>Selected</p>');
});

test('no selection, or a malformed answer, is an empty selection', async () => {
  const answer = async (result) => {
    const request = nextMessage(host);
    const pending = sdk.actions.getSelection();
    const { requestId } = await request;
    host.postMessage({ action: 'sdkResponse', requestId, result });
    return pending;
  };
  assert.equal(await answer({ ok: false, error: 'No selection' }), '');
  assert.equal(await answer({ ok: true }), '');
  assert.equal(await answer('garbage'), '');
  host.close();
});
