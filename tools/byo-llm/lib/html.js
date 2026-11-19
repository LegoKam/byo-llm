/*
 * Turns raw model output into a safe HTML fragment for the preview and the document.
 *
 * Model output is untrusted: the model may have been steered by text in the selection or in
 * an attached file. Everything goes through an allowlist before it reaches innerHTML or the
 * editor. Parsing uses DOMParser, whose documents are inert (no scripts run, nothing loads).
 */

const TEXT_BLOCKS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
const BLOCKS = new Set([...TEXT_BLOCKS, 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'hr']);
const INLINE = new Set(['strong', 'em', 'u', 's', 'sub', 'sup', 'code', 'a', 'br', 'img']);
const ALLOWED = new Set([...BLOCKS, ...INLINE]);
const RENAME = { b: 'strong', i: 'em', strike: 's', del: 's' };

// Removed together with everything inside them.
const DROPPED = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript',
  'template', 'form', 'input', 'button', 'select', 'option', 'textarea', 'svg', 'math',
  'link', 'meta', 'base', 'head', 'title', 'audio', 'video', 'source', 'track', 'canvas', 'dialog',
]);

// Containers the allowlist does not keep, but whose boundaries still mean "new paragraph".
const CONTAINERS = new Set([
  'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'figure', 'figcaption',
  'dl', 'dt', 'dd', 'address', 'details', 'summary', 'center',
]);

const ELEMENT = 1;
const TEXT = 3;

function isSafeHref(value) {
  const href = value.trim();
  if (!href) return false;
  if (/^(https?:|mailto:|tel:)/i.test(href)) return true;
  // Relative links and fragments. Anything with another scheme (javascript:, data:) is out.
  return !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//');
}

const isBlock = (node) => node.nodeType === ELEMENT && BLOCKS.has(node.localName);
const isBlank = (node) => node.nodeType === TEXT && !node.data.trim();

function cleanChildren(node, doc, options) {
  return [...node.childNodes].flatMap((child) => cleanNode(child, doc, options));
}

function cleanNode(node, doc, options) {
  if (node.nodeType === TEXT) return [doc.createTextNode(node.data)];
  if (node.nodeType !== ELEMENT) return [];

  const tag = RENAME[node.localName] || node.localName;
  if (DROPPED.has(tag)) return [];

  if (tag === 'img') {
    const src = node.getAttribute('src') || '';
    if (!options.allowedImages.has(src)) return [];
    const img = doc.createElement('img');
    img.setAttribute('src', src);
    const alt = node.getAttribute('alt');
    if (alt) img.setAttribute('alt', alt);
    return [img];
  }

  const children = cleanChildren(node, doc, options);

  if (!ALLOWED.has(tag)) {
    // An unknown container with only inline content becomes a paragraph, so that
    // <div>one</div><div>two</div> does not collapse into "onetwo".
    if (CONTAINERS.has(tag) && children.length && !children.some(isBlock)) {
      const p = doc.createElement('p');
      p.append(...children);
      return [p];
    }
    return children;
  }

  if (tag === 'a') {
    const href = node.getAttribute('href') || '';
    if (!isSafeHref(href)) return children;
    const a = doc.createElement('a');
    a.setAttribute('href', href.trim());
    a.append(...children);
    return [a];
  }

  const el = doc.createElement(tag);
  if (tag === 'td' || tag === 'th') {
    ['colspan', 'rowspan'].forEach((name) => {
      const value = node.getAttribute(name);
      if (value && /^\d{1,3}$/.test(value)) el.setAttribute(name, value);
    });
  }
  el.append(...children);
  return [el];
}

// The editor expects blocks at the top level: wrap loose text and inline elements in paragraphs.
function wrapLooseInline(nodes, doc) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.some((node) => !isBlank(node))) {
      const p = doc.createElement('p');
      p.append(...run);
      out.push(p);
    }
    run = [];
  };
  nodes.forEach((node) => {
    if (isBlock(node)) {
      flush();
      out.push(node);
    } else {
      run.push(node);
    }
  });
  flush();
  return out;
}

// List items a model returned without their list (it happens when it rewrites "the items").
function wrapLooseItems(nodes, doc) {
  const out = [];
  let list = null; // The <ul> collecting the current run of loose items.
  nodes.forEach((node) => {
    // White space between two items does not end the run.
    if (list && isBlank(node)) return;
    if (node.nodeType !== ELEMENT || node.localName !== 'li') {
      list = null;
      out.push(node);
      return;
    }
    if (!list) {
      list = doc.createElement('ul');
      out.push(list);
    }
    list.append(node);
  });
  return out;
}

const isEmptyTextBlock = (node) => TEXT_BLOCKS.includes(node.localName)
  && !node.textContent.trim() && !node.querySelector('img');

/**
 * @param {string} html Untrusted HTML.
 * @param {object} [options]
 * @param {Iterable<string>} [options.allowedImages] Image URLs to keep, normally the ones that
 *  were in the author's selection. Every other image is removed.
 * @param {Function} [options.DOMParser] Defaults to the global DOMParser.
 * @returns {string} A safe HTML fragment with block elements at the top level.
 */
export function sanitizeHtml(html, { allowedImages = [], DOMParser = globalThis.DOMParser } = {}) {
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><body>${html}`, 'text/html');
  const options = { allowedImages: new Set(allowedImages) };
  const blocks = wrapLooseInline(wrapLooseItems(cleanChildren(doc.body, doc, options), doc), doc)
    .filter((node) => !isEmptyTextBlock(node));
  const out = doc.createElement('div');
  out.append(...blocks);
  return out.innerHTML.trim();
}

/** Image URLs in a piece of HTML. Used to tell which images the author already had. */
export function imageSources(html, { DOMParser = globalThis.DOMParser } = {}) {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><body>${html}`, 'text/html');
  return [...doc.querySelectorAll('img[src]')].map((img) => img.getAttribute('src'));
}

export function htmlToText(html, { DOMParser = globalThis.DOMParser } = {}) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><body>${html}`, 'text/html');
  // textContent runs blocks together; put a line break after each one.
  doc.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, tr, blockquote, br').forEach((el) => {
    el.after(doc.createTextNode('\n'));
  });
  return doc.body.textContent.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/**
 * If the HTML is exactly one paragraph or heading, describes it. The panel uses this to
 * replace text inside a paragraph without splitting the paragraph.
 * @returns {{ tag: string, text: string, plain: boolean }|null} `plain` is true when the
 *  block has no inline markup (bold, links, images…).
 */
export function singleTextBlock(html, { DOMParser = globalThis.DOMParser } = {}) {
  if (!html) return null;
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><body>${html}`, 'text/html');
  const nodes = [...doc.body.childNodes].filter((node) => !isBlank(node));
  if (nodes.length !== 1 || nodes[0].nodeType !== ELEMENT) return null;
  const [el] = nodes;
  if (!TEXT_BLOCKS.includes(el.localName)) return null;
  return {
    tag: el.localName,
    text: el.textContent.replace(/\s+/g, ' ').trim(),
    plain: el.children.length === 0,
  };
}

/* ---------- Raw model output ---------- */

const escapeHtml = (text) => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_([^_\s][^_]*)_(?![\w_])/g, '$1<em>$2</em>');
}

/**
 * A small Markdown reader for models that ignore the "answer in HTML" instruction (local
 * models often do). Handles headings, lists, quotes, paragraphs and basic inline marks.
 */
export function markdownToHtml(markdown) {
  const out = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flush = () => { flushParagraph(); flushList(); };

  markdown.replace(/\r\n?/g, '\n').split('\n').forEach((raw) => {
    const line = raw.trim();
    if (!line) { flush(); return; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdown(heading[2].replace(/\s+#+$/, ''))}</h${level}>`);
      return;
    }

    const bullet = line.match(/^[-*+]\s+(.*)$/);
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet || numbered)[1]);
      return;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flush();
      out.push(`<blockquote><p>${inlineMarkdown(quote[1])}</p></blockquote>`);
      return;
    }

    flushList();
    paragraph.push(line);
  });
  flush();
  return out.join('');
}

const HTML_TAG = /<\/?(p|h[1-6]|ul|ol|li|table|tr|td|th|blockquote|strong|em|b|i|br|div|span|a)\b[^>]*>/i;

/** Strips the wrappers models add around their answer: code fences, a whole HTML document. */
export function unwrapModelOutput(raw) {
  let text = String(raw || '').trim();
  // A fenced block is the answer when it holds HTML, or when the whole answer is one fence.
  const fenced = text.match(/```[\w-]*[ \t]*\n([\s\S]*?)\n?```/);
  if (fenced && (HTML_TAG.test(fenced[1]) || /^```[\s\S]*```$/.test(text))) text = fenced[1].trim();
  const body = text.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (body) text = body[1].trim();
  return text;
}

/**
 * Raw model answer to a safe HTML fragment.
 * @param {string} raw
 * @param {object} [options] Passed to sanitizeHtml.
 */
export function modelOutputToHtml(raw, options) {
  const text = unwrapModelOutput(raw);
  return sanitizeHtml(HTML_TAG.test(text) ? text : markdownToHtml(text), options);
}
