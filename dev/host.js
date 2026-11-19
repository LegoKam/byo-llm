/*
 * A stand-in for the Experience Workspace editor, for local development.
 *
 * It speaks the host side of the App SDK protocol the way da.live does: after the plugin's
 * iframe has loaded it posts `{ ready, context, token }` with a MessagePort, then serves
 * getSelection / sendHTML / sendText / setTitle / closeLibrary on that port.
 *
 * The document is a plain contenteditable, not ProseMirror. Inserting follows the same rules
 * (text stays inside its paragraph, a block splits the paragraph it lands in) but it is an
 * approximation. Check anything subtle about insertion in the real editor.
 */

const SITE = 'demo';
const TOKEN = 'mock-ims-token';
const HANDSHAKE_DELAY = 750;
const TEXT_BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li';
const BLOCKS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'blockquote'];

const $ = (id) => document.getElementById(id);
const editor = $('editor');
const orgSelect = $('org');
const params = new URLSearchParams(window.location.search);
const org = params.get('org') || 'acme';
orgSelect.value = org;

function log(message) {
  $('log').textContent = `${new Date().toLocaleTimeString()}  ${message}`;
}

/* ---------- Selection ---------- */

let saved = null;

function showSaved() {
  if (!window.Highlight || !CSS.highlights) return;
  if (saved && !saved.collapsed) CSS.highlights.set('saved-selection', new Highlight(saved));
  else CSS.highlights.delete('saved-selection');
}

document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return;
  saved = range.cloneRange();
  showSaved();
});

const textBlockOf = (node) => {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const block = element?.closest(TEXT_BLOCKS);
  return block && editor.contains(block) ? block : null;
};

/** A triple-click ends the range at offset 0 of the next block. Pull the end back. */
function trimmed(range) {
  const result = range.cloneRange();
  const { endContainer, endOffset, startContainer } = result;
  const endBlock = textBlockOf(endContainer);
  if (endOffset === 0 && endBlock && endBlock !== textBlockOf(startContainer)) {
    const atBlockStart = document.createRange();
    atBlockStart.selectNodeContents(endBlock);
    atBlockStart.setEnd(endContainer, endOffset);
    if (!atBlockStart.toString()) {
      let previous = endBlock.previousElementSibling || endBlock.parentElement.previousElementSibling;
      while (previous?.lastElementChild && previous.matches('ul, ol')) previous = previous.lastElementChild;
      if (previous) result.setEnd(previous, previous.childNodes.length);
    }
  }
  return result;
}

/** The selection as HTML, wrapped in its block the way the editor reports it. */
function selectionHtml() {
  if (!saved || saved.collapsed) return '';
  const range = trimmed(saved);
  const holder = document.createElement('div');
  // Like the editor, report the selection with the elements around it: part of a paragraph
  // comes back as <p>part</p>, list items come back inside their <ul>.
  let content = range.cloneContents();
  let node = range.commonAncestorContainer;
  if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
  while (node && node !== editor) {
    const wrapper = node.cloneNode(false);
    wrapper.append(content);
    content = wrapper;
    node = node.parentElement;
  }
  holder.append(content);
  return holder.textContent.trim() || holder.querySelector('img') ? holder.innerHTML : '';
}

function targetRange() {
  if (saved && editor.contains(saved.commonAncestorContainer)) return trimmed(saved);
  const end = document.createRange();
  end.selectNodeContents(editor);
  end.collapse(false);
  return end;
}

function placeCaretAfter(node) {
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  // Move the real selection too, or it would still span the replaced content.
  const selection = window.getSelection();
  if (selection.rangeCount && editor.contains(selection.anchorNode)) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
  saved = range.cloneRange();
  showSaved();
}

const isEmpty = (element) => !element.textContent.trim() && !element.querySelector('img');

function removeEmptyBlocks() {
  editor.querySelectorAll(TEXT_BLOCKS).forEach((block) => { if (isEmpty(block)) block.remove(); });
  editor.querySelectorAll('ul, ol').forEach((list) => { if (!list.children.length) list.remove(); });
}

function insertText(text) {
  const range = targetRange();
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  placeCaretAfter(node);
}

function insertHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const fragment = template.content;
  const nodes = [...fragment.childNodes];
  if (!nodes.length) return;
  const blockLevel = [...fragment.children].some((child) => BLOCKS.includes(child.localName));

  const range = targetRange();
  range.deleteContents();

  if (!blockLevel) {
    range.insertNode(fragment);
    placeCaretAfter(nodes.at(-1));
    return;
  }

  // A block cannot live inside a paragraph or a list: split the top-level block at the cursor.
  let container = range.startContainer;
  while (container && container !== editor && container.parentNode !== editor) container = container.parentNode;
  if (!container || container === editor) {
    range.insertNode(fragment);
  } else {
    const tailRange = document.createRange();
    tailRange.setStart(range.startContainer, range.startOffset);
    tailRange.setEndAfter(container.lastChild || container);
    const tail = tailRange.extractContents();
    container.after(fragment);
    if (tail.textContent.trim()) {
      const rest = container.cloneNode(false);
      rest.append(tail);
      nodes.at(-1).after(rest);
    }
  }
  placeCaretAfter(nodes.at(-1));
  removeEmptyBlocks();
}

/* ---------- SDK host ---------- */

function serve(frame, context, { hasEditor }) {
  let port;
  frame.addEventListener('load', () => {
    port?.close();
    setTimeout(() => {
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = ({ data }) => {
        const { action, details, requestId } = data || {};
        if (action === 'getSelection') {
          const html = hasEditor ? selectionHtml() : '';
          const result = html ? { ok: true, html } : { ok: false, error: 'No selection' };
          port.postMessage({ action: 'sdkResponse', requestId, result });
          return;
        }
        if (action === 'setTitle') {
          if (hasEditor) $('plugin-title').textContent = details;
          return;
        }
        if (action === 'closeLibrary') {
          $('library').hidden = true;
        } else if (action === 'sendText' && hasEditor) {
          insertText(String(details));
        } else if (action === 'sendHTML' && hasEditor) {
          insertHtml(String(details));
        }
        log(`${action}${typeof details === 'string' ? `: ${details.slice(0, 160)}` : ''}`);
      };
      frame.contentWindow.postMessage(
        { ready: true, context, token: TOKEN, capabilities: {} },
        window.location.origin,
        [channel.port2],
      );
    }, HANDSHAKE_DELAY);
  });
}

const plugin = $('plugin');
const appFrame = $('app-frame');
const PLUGIN_URL = '/plugin/tools/byo-llm/byo-llm.html?mock-da';
// The real shell forwards its own query and fragment to the app, so the site travels in `#/org/site`.
const APP_URL = `/plugin/tools/byo-llm/config.html?mock-da#/${org}/${SITE}`;

serve(plugin, {
  org, repo: SITE, site: SITE, ref: 'main', path: '/drafts/larapinta-trail', view: 'edit',
}, { hasEditor: true });
// A fullscreen app gets the repository its code is served from, which is not the site to configure.
serve(appFrame, { org: 'plugin-owner', repo: 'ew-byo-llm', ref: 'main', path: 'plugin/tools/byo-llm/config' }, { hasEditor: false });
plugin.src = PLUGIN_URL;

/* ---------- Toolbar ---------- */

orgSelect.addEventListener('change', () => {
  window.location.search = `?org=${orgSelect.value}`;
});

async function setState(action) {
  await fetch(`/mock/${action}?org=${org}&site=${SITE}`, { method: 'POST' });
  log(action === 'seed' ? 'Seeded three mock connections (API key: mock-key).' : 'Cleared the settings sheet.');
  plugin.src = PLUGIN_URL;
  if (!$('app').hidden) appFrame.src = APP_URL;
}
$('seed').addEventListener('click', () => setState('seed'));
$('reset').addEventListener('click', () => setState('reset'));

$('toggle-app').addEventListener('click', ({ target }) => {
  const open = $('app').hidden;
  $('app').hidden = !open;
  target.textContent = open ? 'Close settings app' : 'Open settings app';
  if (open) appFrame.src = APP_URL;
  else plugin.src = PLUGIN_URL;
});

$('toggle-panel').addEventListener('click', ({ target }) => {
  const library = $('library');
  library.hidden = !library.hidden;
  target.textContent = library.hidden ? 'Open plugin' : 'Close plugin';
});

// For driving the host from the console or from automated checks.
window.mockHost = {
  select(selector, start, end) {
    const node = editor.querySelector(selector);
    const range = document.createRange();
    if (start === undefined) {
      range.selectNodeContents(node);
    } else {
      range.setStart(node.firstChild, start);
      range.setEnd(node.firstChild, end);
    }
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    saved = range.cloneRange();
    showSaved();
  },
  selectionHtml,
};

log(`Ready. Org "${org}", site "${SITE}". Select text in the document, then use the panel.`);
