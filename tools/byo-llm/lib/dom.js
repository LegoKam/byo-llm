/* Small DOM helpers. The UI is plain DOM: no framework, no build step. */

/**
 * Creates an element.
 * @param {string} tag
 * @param {object} [props] `class`, `text`, `dataset`, `on<event>` listeners; anything else is
 *  set as an attribute (true sets an empty attribute, false / null / undefined skip it).
 * @param {...(Node|string|null|undefined|false)} children
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  Object.entries(props || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : value);
  });
  el.append(...children.flat().filter((child) => child !== undefined && child !== null && child !== false));
  return el;
}

// 20x20 outline icons, drawn for this plugin.
const ICON_PATHS = {
  sparkle: '<path d="M10 2.5l1.7 4.3a2 2 0 0 0 1.1 1.1l4.3 1.7-4.3 1.7a2 2 0 0 0-1.1 1.1L10 16.7l-1.7-4.3a2 2 0 0 0-1.1-1.1L2.9 9.6l4.3-1.7a2 2 0 0 0 1.1-1.1z"/><path d="M15.8 2v3M14.3 3.5h3"/>',
  settings: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.2v2.1M10 15.7v2.1M3.2 6.1l1.8 1M15 12.9l1.8 1M3.2 13.9l1.8-1M15 7.1l1.8-1"/>',
  back: '<path d="M11.5 4.5L6 10l5.5 5.5"/>',
  refresh: '<path d="M16 10a6 6 0 1 1-1.8-4.3"/><path d="M16.2 3.2v3.3h-3.3"/>',
  attach: '<path d="M14.6 9.3l-4.9 4.9a3 3 0 0 1-4.3-4.3l5.6-5.6a2 2 0 0 1 2.9 2.9l-5.5 5.4a1 1 0 0 1-1.4-1.4l4.8-4.8"/>',
  close: '<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>',
  copy: '<rect x="7" y="7" width="9.5" height="9.5" rx="1.8"/><path d="M4.8 12.8h-.3a1.5 1.5 0 0 1-1.5-1.5V4.9a1.5 1.5 0 0 1 1.5-1.5h6.4a1.5 1.5 0 0 1 1.5 1.5v.3"/>',
  check: '<path d="M4.5 10.5l3.5 3.5 7.5-8"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  alert: '<path d="M10 3.2l7.2 12.6H2.8z"/><path d="M10 8.3v3.4M10 14h0"/>',
  text: '<path d="M5 3.5h7l3.5 3.5v9a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/><path d="M7.5 10h5M7.5 13h5"/>',
  image: '<rect x="3" y="4" width="14" height="12" rx="1.8"/><circle cx="7.3" cy="8.2" r="1.2"/><path d="M3.5 14l3.8-3.5 3 2.6 2.4-2 3.8 3.2"/>',
};

export function icon(name) {
  const span = document.createElement('span');
  span.className = `icon icon-${name}`;
  span.setAttribute('aria-hidden', 'true');
  // Fixed markup from the table above, never user or model content.
  span.innerHTML = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ''}</svg>`;
  return span;
}

/** Replaces everything inside `el` with the given children. */
export function setChildren(el, ...children) {
  el.replaceChildren(...children.flat().filter((child) => child !== undefined && child !== null && child !== false));
}
