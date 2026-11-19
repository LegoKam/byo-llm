/*
 * Local development server. Everything the plugin talks to is faked here, so the whole flow
 * runs offline and without real credentials:
 *
 *   /dev/host.html            a stand-in for the Experience Workspace editor (the SDK host)
 *   /tools/...                the plugin, served as the AEM CDN would
 *   /mock/da/...              DA admin: the settings sheet (kept in dev/.state/)
 *   /mock/openai/...          OpenAI chat completions
 *   /mock/anthropic/...       Anthropic messages
 *   /mock/gemini/...          Gemini generateContent
 *   /mock/proxy/generate      the App Builder action, run in-process against the mocks
 *
 * Nothing here ships: .hlxignore keeps dev/ off the CDN.
 */

import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMain } from '../app-builder/actions/generate/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'dev', '.state', 'da.json');
const PORT = Number(process.env.PORT) || 3000;
const ORIGIN = `http://localhost:${PORT}`;

export const MOCK_TOKEN = 'mock-ims-token';
export const MOCK_KEY = 'mock-key';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !(body instanceof Uint8Array);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/* ---------- Mock DA admin ---------- */

let sheets;

async function loadSheets() {
  if (sheets) return sheets;
  try {
    sheets = JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    sheets = {};
  }
  return sheets;
}

async function saveSheets() {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(sheets, null, 2));
}

const sheetData = (data) => ({ total: data.length, limit: data.length, offset: 0, data });

/** Three connections that point at the mock providers below. */
function seedSheet() {
  const connection = (name, provider, endpoint, model) => ({
    name, provider, endpoint, model, apiKey: MOCK_KEY, apiVersion: '', keyHeader: '',
  });
  return {
    ...sheetData([{ key: 'about', value: 'Seeded by the dev server.' }]),
    ':sheetname': 'info',
    ':type': 'sheet',
    ':private': {
      'private-connections': sheetData([
        connection('Mock GPT', 'openai-compatible', `${ORIGIN}/mock/openai/v1`, 'mock-gpt'),
        connection('Mock Claude', 'anthropic', `${ORIGIN}/mock/anthropic`, 'mock-claude'),
        connection('Mock Gemini', 'gemini', `${ORIGIN}/mock/gemini/v1beta`, 'mock-gemini'),
      ]),
      'private-settings': sheetData([
        { key: 'default', value: 'Mock GPT' },
        { key: 'brandGuidelines', value: 'Friendly and direct. British English. No exclamation marks.' },
        { key: 'proxyUrl', value: '' },
      ]),
    },
  };
}

/*
 * Org names choose the behaviour, so every permission state can be tried from the host page:
 *   "readonly"  may read the settings, may not write them
 *   "denied"    may not read them
 * Any other org may do both.
 */
async function handleDa(req, res, url) {
  const route = url.pathname.replace('/mock/da', '');

  if (route.startsWith('/ping/')) {
    send(res, 200, 'pong');
    return;
  }

  const match = route.match(/^\/source\/([^/]+)\/([^/]+)\/\.da\/byo-llm\.json$/);
  if (!match) {
    send(res, 404, 'Not found');
    return;
  }
  if (req.headers.authorization !== `Bearer ${MOCK_TOKEN}`) {
    send(res, 401, 'Unauthorized');
    return;
  }
  const [, org, site] = match;
  const key = `${org}/${site}`;
  if (org === 'denied') {
    send(res, 403, 'Forbidden');
    return;
  }
  const actions = org === 'readonly' ? 'read' : 'read,write';
  const headers = { 'x-da-actions': `/${key}/.da/byo-llm.json=${actions}` };
  const all = await loadSheets();

  if (req.method === 'GET') {
    if (!all[key]) send(res, 404, 'Not found', headers);
    else send(res, 200, all[key], headers);
    return;
  }
  if (req.method === 'POST') {
    if (org === 'readonly') {
      send(res, 403, 'Forbidden', headers);
      return;
    }
    // DA admin takes the document as a multipart form field named "data".
    const form = await new Request(ORIGIN, {
      method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: await readBody(req),
    }).formData();
    all[key] = JSON.parse(await form.get('data').text());
    await saveSheets();
    send(res, 201, { source: { editUrl: `https://da.live/sheet#/${key}/.da/byo-llm` } }, headers);
    return;
  }
  send(res, 405, 'Method not allowed');
}

async function handleState(req, res, url) {
  if (req.method !== 'POST') {
    send(res, 405, 'Method not allowed');
    return;
  }
  const key = `${url.searchParams.get('org')}/${url.searchParams.get('site')}`;
  const all = await loadSheets();
  if (url.pathname === '/mock/seed') all[key] = seedSheet();
  else delete all[key];
  await saveSheets();
  send(res, 200, { ok: true });
}

/* ---------- Mock LLM ---------- */

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Rewrites the text between tags and leaves the markup alone. */
const mapText = (html, fn) => html.replace(/>([^<]+)</g, (all, text) => (text.trim() ? `>${fn(text)}<` : all));

/**
 * A deterministic stand-in for a model. It understands the prompt layout of lib/prompt.js well
 * enough to return something that looks like the requested edit.
 * @param {{ model: string, system: string, turns: { role: string, text: string, images: number, files: number }[] }} chat
 */
function mockAnswer({ model, system, turns }) {
  const users = turns.filter((turn) => turn.role === 'user');
  const first = users[0]?.text || '';
  const last = users.at(-1)?.text || '';
  const instruction = (first.match(/^Request:\n([\s\S]*?)(?:\n\nSelected content|\n\nNothing is selected|$)/) || [])[1] || first;
  const selection = (first.match(/<selection>\n([\s\S]*?)\n<\/selection>/) || [])[1] || '';
  const fileNames = [...first.matchAll(/<file name="([^"]*)">/g)].map((found) => found[1]);
  const images = users.reduce((sum, turn) => sum + turn.images, 0);
  const pdfs = users.reduce((sum, turn) => sum + turn.files, 0);

  if (last.startsWith('Revise your previous response:')) {
    const previous = turns.filter((turn) => turn.role === 'assistant').at(-1)?.text || '';
    const change = last.slice('Revise your previous response:'.length).split('\n')[0].trim();
    return `${previous}<p><em>Revised by ${escapeHtml(model)}: ${escapeHtml(change)}</em></p>`;
  }

  if (model.includes('markdown')) {
    return '```markdown\n## A Markdown answer\n\nSome models ignore the format and answer in **Markdown**.\n\n- The plugin converts it\n- So it still lands as real content\n```';
  }
  if (model.includes('unsafe')) {
    return '<p onclick="alert(1)" style="color:red">Safe text survives.</p><script>alert("xss")</script><img src="https://tracker.example/pixel.gif"><p><a href="javascript:alert(1)">bad link</a> and <a href="https://example.com/">good link</a></p>';
  }

  if (selection) {
    const translate = instruction.match(/^Translate the selected content into (.+?)\./);
    if (translate) return mapText(selection, (text) => `[${translate[1]}] ${text}`);
    if (instruction.startsWith('Shorten')) {
      return mapText(selection, (text) => {
        const words = text.trim().split(/\s+/);
        return words.length > 6 ? `${words.slice(0, Math.ceil(words.length / 2)).join(' ')}.` : text;
      });
    }
    if (instruction.startsWith('Summarise')) {
      const words = selection.replace(/<[^>]+>/g, ' ').trim().split(/\s+/);
      return `<p>In short: ${escapeHtml(words.slice(0, 18).join(' '))}…</p>`;
    }
    if (instruction.startsWith('Correct spelling')) {
      return mapText(selection, (text) => text.replace(/\bteh\b/g, 'the').replace(/\brecieve\b/g, 'receive').replace(/ {2,}/g, ' '));
    }
    let tagged = false;
    return mapText(selection, (text) => {
      if (tagged) return text;
      tagged = true;
      return `${text.trimEnd()} (rewritten by ${escapeHtml(model)})`;
    });
  }

  const seen = [
    ...fileNames.map((name) => `${name} (text)`),
    images && `${images} image${images > 1 ? 's' : ''}`,
    pdfs && `${pdfs} PDF${pdfs > 1 ? 's' : ''}`,
  ].filter(Boolean);
  return [
    `<h2>Mock answer from ${escapeHtml(model)}</h2>`,
    `<p>You asked: <strong>${escapeHtml(instruction.slice(0, 200))}</strong></p>`,
    '<ul>',
    `<li>Attachments read: ${seen.length ? escapeHtml(seen.join(', ')) : 'none'}</li>`,
    `<li>Brand guidelines received: ${system.includes('<brand-guidelines>') ? 'yes' : 'no'}</li>`,
    '</ul>',
  ].join('');
}

const tokens = (text) => Math.ceil(text.length / 4);

// Each provider: how to check the key, read the request, and shape the answer and errors.
const LLM_MOCKS = [
  {
    match: (pathname) => pathname === '/mock/openai/v1/chat/completions',
    key: (req) => (req.headers.authorization || '').replace(/^Bearer /, ''),
    read: (body) => ({
      model: body.model,
      system: body.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n'),
      turns: body.messages.filter((message) => message.role !== 'system').map(({ role, content }) => {
        const parts = Array.isArray(content) ? content : [{ type: 'text', text: content }];
        return {
          role,
          text: parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n\n'),
          images: parts.filter((part) => part.type === 'image_url').length,
          files: parts.filter((part) => part.type === 'file').length,
        };
      }),
    }),
    answer: (chat, text, prompt) => ({
      id: 'chatcmpl-mock',
      model: chat.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: tokens(prompt), completion_tokens: tokens(text) },
    }),
    error: (message) => ({ error: { message, type: 'invalid_request_error' } }),
  },
  {
    match: (pathname) => pathname === '/mock/anthropic/v1/messages',
    key: (req) => req.headers['x-api-key'],
    read: (body) => ({
      model: body.model,
      system: body.system || '',
      turns: body.messages.map(({ role, content }) => ({
        role,
        text: content.filter((part) => part.type === 'text').map((part) => part.text).join('\n\n'),
        images: content.filter((part) => part.type === 'image').length,
        files: content.filter((part) => part.type === 'document').length,
      })),
    }),
    answer: (chat, text, prompt) => ({
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: chat.model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: tokens(prompt), output_tokens: tokens(text) },
    }),
    error: (message) => ({ type: 'error', error: { type: 'authentication_error', message } }),
  },
  {
    match: (pathname) => /^\/mock\/gemini\/v1beta\/models\/[^/]+:generateContent$/.test(pathname),
    key: (req) => req.headers['x-goog-api-key'],
    read: (body, pathname) => ({
      model: decodeURIComponent(pathname.match(/models\/([^/]+):generateContent$/)[1]),
      system: (body.systemInstruction?.parts || []).map((part) => part.text).join('\n'),
      turns: body.contents.map(({ role, parts }) => ({
        role: role === 'model' ? 'assistant' : 'user',
        text: parts.filter((part) => part.text).map((part) => part.text).join('\n\n'),
        images: parts.filter((part) => part.inlineData?.mimeType.startsWith('image/')).length,
        files: parts.filter((part) => part.inlineData?.mimeType === 'application/pdf').length,
      })),
    }),
    answer: (chat, text, prompt) => ({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
      modelVersion: chat.model,
      usageMetadata: { promptTokenCount: tokens(prompt), candidatesTokenCount: tokens(text) },
    }),
    error: (message) => ({ error: { code: 401, message, status: 'UNAUTHENTICATED' } }),
  },
];

async function handleLlm(req, res, url, mock) {
  // The plugin calls these cross-origin in real life, so answer like a CORS-enabled API.
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  if (req.method === 'OPTIONS') {
    send(res, 204, '', cors);
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, 'Method not allowed', cors);
    return;
  }
  if (mock.key(req) !== MOCK_KEY) {
    send(res, 401, mock.error(`Incorrect API key provided. The dev server accepts "${MOCK_KEY}".`), cors);
    return;
  }
  const chat = mock.read(JSON.parse((await readBody(req)).toString('utf8')), url.pathname);

  // Model names choose the behaviour: slow, error, or (in mockAnswer) markdown and unsafe.
  if (chat.model.includes('slow')) await sleep(6000);
  if (chat.model.includes('error')) {
    send(res, 429, mock.error('Rate limit reached for this mock model.'), cors);
    return;
  }
  await sleep(600);
  const text = mockAnswer(chat);
  const prompt = chat.system + chat.turns.map((turn) => turn.text).join('');
  send(res, 200, mock.answer(chat, text, prompt), cors);
}

/* ---------- Mock proxy: the real action, pointed at the mocks ---------- */

const proxyOrigins = { daAdmin: `${ORIGIN}/mock/da`, hlxAdmin: `${ORIGIN}/mock/da`, aemApi: `${ORIGIN}/mock/da` };
const proxyMain = createMain({ origins: proxyOrigins, allowInsecureEndpoints: true });

async function handleProxy(req, res) {
  let body = {};
  if (req.method === 'POST') {
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      body = {};
    }
  }
  // As Adobe I/O Runtime does: inputs first, then the JSON body, then the request metadata.
  const result = await proxyMain({
    ...body,
    BYO_LLM_ALLOWED_ORGS: process.env.BYO_LLM_ALLOWED_ORGS || 'acme, readonly',
    __ow_method: req.method.toLowerCase(),
    __ow_headers: req.headers,
  });
  send(res, result.statusCode, result.body, result.headers);
}

/* ---------- Static files ---------- */

async function handleStatic(req, res, url) {
  if (url.pathname === '/') {
    // Redirect rather than serve in place, so the host page's relative URLs resolve.
    res.writeHead(302, { Location: `/dev/host.html${url.search}` });
    res.end();
    return;
  }
  const pathname = decodeURIComponent(url.pathname);
  const file = path.join(ROOT, path.normalize(pathname));
  const servable = ['tools', 'dev'].some((dir) => file.startsWith(path.join(ROOT, dir) + path.sep));
  if (!servable || file.includes(`${path.sep}.`)) {
    send(res, 404, 'Not found');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    send(res, 404, 'Not found');
  }
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  try {
    const llm = LLM_MOCKS.find((mock) => mock.match(url.pathname));
    if (llm) await handleLlm(req, res, url, llm);
    else if (url.pathname.startsWith('/mock/da/')) await handleDa(req, res, url);
    else if (url.pathname === '/mock/seed' || url.pathname === '/mock/reset') await handleState(req, res, url);
    else if (url.pathname === '/mock/proxy/generate') await handleProxy(req, res);
    else await handleStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, 'Dev server error');
    else res.end();
  }
});

// Loopback only: this server hands out a fake admin API and must not be reachable from the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`BYO LLM dev host: ${ORIGIN}/`);
  console.log(`Mock API key for every mock provider: ${MOCK_KEY}`);
});
