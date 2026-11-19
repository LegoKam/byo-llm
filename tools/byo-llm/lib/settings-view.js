/*
 * The settings UI: LLM connections, brand guidelines and the optional proxy.
 * Used inside the plugin panel (gear icon) and as the fullscreen config app.
 *
 * Every explicit action (save a connection, delete, make default, save guidelines) writes the
 * sheet straight away, so there is no "unsaved changes" state to lose.
 */

import { h, icon, setChildren } from './dom.js';
import {
  PROVIDERS, emptyConfig, maskKey, normalizeConnection, validateConnection, validateSettings,
} from './config-model.js';
import { callLlm } from './providers.js';
import { generate } from './llm.js';

const TEST_REQUEST = {
  system: 'You are a connection test. Follow the instruction exactly.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word OK.' }] }],
};

let fieldCount = 0;

/** A labelled form control with an optional hint and an error slot. */
function field({ label, hint, control }) {
  fieldCount += 1;
  const id = `byo-field-${fieldCount}`;
  control.id = id;
  const error = h('p', { class: 'field-error', id: `${id}-error`, hidden: true });
  const described = [`${id}-error`];
  const children = [h('label', { for: id, text: label }), control];
  if (hint) {
    children.push(h('p', { class: 'field-hint', id: `${id}-hint`, text: hint }));
    described.push(`${id}-hint`);
  }
  control.setAttribute('aria-describedby', described.join(' '));
  const el = h('div', { class: 'field' }, ...children, error);
  const setError = (message) => {
    error.textContent = message || '';
    error.hidden = !message;
    control.toggleAttribute('aria-invalid', !!message);
  };
  // An error describes what was there when the form was checked. Editing the field retires it.
  control.addEventListener('input', () => setError(''));
  return { el, control, setError };
}

/**
 * @param {HTMLElement} root
 * @param {object} options
 * @param {object} options.store From createStore.
 * @param {{ org: string, site: string }} options.context
 * @param {() => string} options.getToken
 * @param {Function} [options.fetch] Used for the connection test.
 * @param {(config: object) => void} [options.onChange] Called after every successful save.
 * @returns {{ destroy: () => void }}
 */
export default function mountSettings(root, {
  store, context, getToken, fetch, onChange = () => {},
}) {
  const state = {
    status: 'loading',
    error: '',
    config: emptyConfig(),
    canWrite: undefined,
    editing: null, // { index, draft } while the connection form is open; index -1 is a new one
    confirmDelete: -1,
    busy: false,
  };

  const view = h('div', { class: 'settings' });
  const toast = h('p', { class: 'toast', role: 'status', hidden: true });
  let toastTimer;
  root.replaceChildren(view, toast);

  const readOnly = () => state.canWrite === false;

  function announce(message, kind = 'success') {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `toast toast-${kind}`;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, kind === 'error' ? 8000 : 3500);
  }

  async function persist(nextConfig, message) {
    state.busy = true;
    try {
      await store.save(nextConfig);
      state.config = nextConfig;
      onChange(nextConfig);
      announce(message);
      return true;
    } catch (error) {
      announce(error.message, 'error');
      return false;
    } finally {
      state.busy = false;
    }
  }

  /* ---------- Connection form ---------- */

  function renderConnectionForm() {
    const { index, draft } = state.editing;
    const isNew = index < 0;

    const name = field({
      label: 'Name',
      hint: 'What authors see in the model picker, for example "Marketing GPT".',
      control: h('input', { type: 'text', value: draft.name, maxlength: 60, autocomplete: 'off' }),
    });
    const provider = field({
      label: 'Provider',
      control: h(
        'select',
        {},
        ...Object.entries(PROVIDERS).map(([id, info]) => h('option', { value: id, selected: id === draft.provider, text: info.label })),
      ),
    });
    const endpoint = field({
      label: 'Endpoint URL',
      control: h('input', { type: 'url', value: draft.endpoint, autocomplete: 'off', spellcheck: 'false' }),
    });
    const model = field({
      label: 'Model',
      control: h('input', { type: 'text', value: draft.model, autocomplete: 'off', spellcheck: 'false' }),
    });
    const apiKeyInput = h('input', { type: 'password', value: draft.apiKey, autocomplete: 'off', spellcheck: 'false' });
    const apiKey = field({ label: 'API key', control: apiKeyInput });
    const reveal = h('button', {
      type: 'button',
      class: 'button-quiet reveal',
      'aria-pressed': 'false',
      text: 'Show',
      onClick: () => {
        const show = apiKeyInput.type === 'password';
        apiKeyInput.type = show ? 'text' : 'password';
        reveal.textContent = show ? 'Hide' : 'Show';
        reveal.setAttribute('aria-pressed', String(show));
      },
    });
    apiKeyInput.after(reveal);
    apiKey.el.classList.add('field-key');

    const apiVersion = field({
      label: 'API version',
      hint: `Leave empty to use ${PROVIDERS['azure-openai'].apiVersion}.`,
      control: h('input', { type: 'text', value: draft.apiVersion, autocomplete: 'off', spellcheck: 'false' }),
    });
    const keyHeader = field({
      label: 'API key header',
      hint: 'Leave empty to send "Authorization: Bearer <key>". Enter a header name, such as x-api-key, if your gateway expects the key there.',
      control: h('input', { type: 'text', value: draft.keyHeader, autocomplete: 'off', spellcheck: 'false' }),
    });

    const fields = { name, provider, endpoint, model, apiKey, apiVersion, keyHeader };
    const testStatus = h('p', { class: 'test-status', role: 'status' });

    const read = () => normalizeConnection(Object.fromEntries(
      Object.entries(fields).map(([key, f]) => [key, f.control.value]),
    ));

    // Labels, placeholders and optional fields depend on the provider.
    function applyProvider(previous) {
      const info = PROVIDERS[provider.control.value];
      const previousDefault = previous ? PROVIDERS[previous].endpoint : '';
      const current = endpoint.control.value.trim();
      if (!current || current === previousDefault) endpoint.control.value = info.endpoint;
      endpoint.control.placeholder = info.endpointHint;
      model.el.querySelector('label').textContent = info.modelLabel || 'Model';
      model.control.placeholder = info.modelHint;
      apiKey.el.querySelector('label').textContent = info.keyRequired ? 'API key' : 'API key (optional)';
      apiVersion.el.hidden = provider.control.value !== 'azure-openai';
      keyHeader.el.hidden = !info.customKeyHeader;
    }
    let lastProvider = draft.provider;
    provider.control.addEventListener('change', () => {
      applyProvider(lastProvider);
      lastProvider = provider.control.value;
      // What is required differs per provider, so the old errors no longer apply.
      Object.values(fields).forEach((f) => f.setError(''));
      testStatus.className = 'test-status';
      testStatus.textContent = '';
    });
    applyProvider();

    // state.editing.index is read at call time: "Save and test" turns a new connection into
    // a saved one while this form stays open.
    function validate() {
      const conn = read();
      const otherNames = state.config.connections
        .filter((_, i) => i !== state.editing.index)
        .map((other) => other.name);
      const errors = validateConnection(conn, { otherNames });
      Object.entries(fields).forEach(([key, f]) => f.setError(errors[key]));
      const firstInvalid = Object.keys(fields).find((key) => errors[key]);
      if (firstInvalid) fields[firstInvalid].control.focus();
      return firstInvalid ? null : conn;
    }

    async function saveConnection(conn, { close }) {
      const position = state.editing.index;
      const connections = [...state.config.connections];
      if (position < 0) connections.push(conn);
      else connections[position] = conn;
      const settings = { ...state.config.settings };
      // Keep "default" pointing at this connection if it was renamed; the first one added is the default.
      const previousName = state.config.connections[position]?.name;
      if (previousName && settings.default === previousName) settings.default = conn.name;
      if (!settings.default) settings.default = conn.name;

      const saved = await persist({ connections, settings }, `Saved "${conn.name}".`);
      if (!saved) return false;
      state.editing = close ? null : { index: connections.indexOf(conn), draft: conn };
      return true;
    }

    const saveButton = h('button', { type: 'submit', class: 'button-primary', text: 'Save connection' });
    const testButton = h('button', {
      type: 'button',
      class: 'button-secondary',
      text: state.config.settings.proxyUrl ? 'Save and test' : 'Test connection',
    });
    const cancelButton = h('button', {
      type: 'button',
      class: 'button-quiet',
      text: 'Cancel',
      onClick: () => { state.editing = null; render(); },
    });
    const setBusy = (busy) => [saveButton, testButton, cancelButton].forEach((button) => { button.disabled = busy; });

    testButton.addEventListener('click', async () => {
      const conn = validate();
      if (!conn) return;
      setBusy(true);
      testStatus.className = 'test-status';
      testStatus.textContent = 'Testing…';
      const started = Date.now();
      try {
        const { proxyUrl } = state.config.settings;
        if (proxyUrl) {
          // The proxy reads the saved sheet, so the connection has to be saved first.
          if (!await saveConnection(conn, { close: false })) throw new Error('Could not save the connection.');
          await generate({
            config: state.config, connection: conn, request: TEST_REQUEST, context, token: getToken(), fetch,
          });
        } else {
          await callLlm(conn, TEST_REQUEST, { fetch });
        }
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        testStatus.className = 'test-status test-ok';
        testStatus.textContent = `Connected. ${conn.model} answered in ${seconds} s.`;
      } catch (error) {
        testStatus.className = 'test-status test-failed';
        testStatus.textContent = error.code === 'network'
          ? `${error.message} If the endpoint does not accept requests from a browser, set up the proxy under Advanced.`
          : error.message;
      } finally {
        setBusy(false);
      }
    });

    return h(
      'form',
      {
        class: 'connection-form',
        novalidate: true,
        'aria-label': isNew ? 'New connection' : `Edit ${draft.name}`,
        onSubmit: async (event) => {
          event.preventDefault();
          const conn = validate();
          if (!conn) return;
          setBusy(true);
          const saved = await saveConnection(conn, { close: true });
          // On failure the form stays as it is, so nothing the admin typed is lost.
          if (saved) render();
          else setBusy(false);
        },
      },
      h('h3', { text: isNew ? 'New connection' : 'Edit connection' }),
      name.el,
      provider.el,
      endpoint.el,
      model.el,
      apiKey.el,
      apiVersion.el,
      keyHeader.el,
      testStatus,
      h('div', { class: 'form-actions' }, saveButton, testButton, cancelButton),
    );
  }

  /* ---------- Connection list ---------- */

  function renderConnection(conn, index) {
    const info = PROVIDERS[conn.provider];
    const isDefault = state.config.settings.default === conn.name
      || (!state.config.settings.default && index === 0);
    const disabled = readOnly() || state.busy;

    if (state.confirmDelete === index) {
      return h(
        'li',
        { class: 'connection connection-confirm' },
        h('p', { text: `Delete "${conn.name}"? Authors will no longer be able to use it.` }),
        h(
          'div',
          { class: 'connection-actions' },
          h('button', {
            type: 'button',
            class: 'button-negative',
            text: 'Delete',
            onClick: async () => {
              const connections = state.config.connections.filter((_, i) => i !== index);
              const settings = { ...state.config.settings };
              if (settings.default === conn.name) settings.default = connections[0]?.name || '';
              state.confirmDelete = -1;
              await persist({ connections, settings }, `Deleted "${conn.name}".`);
              render();
            },
          }),
          h('button', {
            type: 'button', class: 'button-quiet', text: 'Keep', onClick: () => { state.confirmDelete = -1; render(); },
          }),
        ),
      );
    }

    return h(
      'li',
      { class: 'connection' },
      h(
        'div',
        { class: 'connection-info' },
        h('p', { class: 'connection-name' }, conn.name, isDefault && h('span', { class: 'badge', text: 'Default' })),
        h('p', { class: 'connection-meta', text: `${info ? info.label : conn.provider} · ${conn.model}` }),
        conn.apiKey && h('p', { class: 'connection-meta connection-key', text: `Key ${maskKey(conn.apiKey)}` }),
      ),
      h(
        'div',
        { class: 'connection-actions' },
        !isDefault && h('button', {
          type: 'button',
          class: 'button-quiet',
          text: 'Make default',
          disabled,
          onClick: async () => {
            await persist(
              { ...state.config, settings: { ...state.config.settings, default: conn.name } },
              `"${conn.name}" is now the default.`,
            );
            render();
          },
        }),
        h('button', {
          type: 'button',
          class: 'button-quiet',
          text: 'Edit',
          disabled,
          'aria-label': `Edit ${conn.name}`,
          onClick: () => { state.editing = { index, draft: { ...conn } }; state.confirmDelete = -1; render(); },
        }),
        h('button', {
          type: 'button',
          class: 'button-quiet',
          text: 'Delete',
          disabled,
          'aria-label': `Delete ${conn.name}`,
          onClick: () => { state.confirmDelete = index; state.editing = null; render(); },
        }),
      ),
    );
  }

  function renderConnections() {
    const { connections } = state.config;
    const adding = state.editing?.index === -1;

    const items = connections.map((conn, index) => (state.editing?.index === index
      ? h('li', { class: 'connection connection-editing' }, renderConnectionForm())
      : renderConnection(conn, index)));

    return h(
      'section',
      { class: 'settings-section' },
      h('h2', { text: 'LLM connections' }),
      h('p', { class: 'section-hint', text: 'The models authors can choose from when they generate content.' }),
      connections.length
        ? h('ul', { class: 'connections' }, ...items)
        : !adding && h('p', { class: 'empty', text: 'No LLM is connected yet. Add a connection to let authors generate content with your organisation\'s model.' }),
      adding && renderConnectionForm(),
      !state.editing && h(
        'button',
        {
          type: 'button',
          class: connections.length ? 'button-secondary' : 'button-primary',
          disabled: readOnly(),
          onClick: () => {
            state.editing = { index: -1, draft: normalizeConnection({ provider: 'openai' }) };
            state.confirmDelete = -1;
            render();
          },
        },
        icon('plus'),
        'Add connection',
      ),
    );
  }

  /* ---------- Brand guidelines and proxy ---------- */

  function renderGeneral() {
    const { settings } = state.config;
    const guidelines = field({
      label: 'Voice, tone and rules',
      hint: 'How your organisation writes: tone of voice, vocabulary, spelling, things to avoid. The model gets this with every request.',
      control: h('textarea', { rows: 7, spellcheck: 'true', disabled: readOnly() }),
    });
    guidelines.control.value = settings.brandGuidelines;

    const proxy = field({
      label: 'Proxy URL',
      hint: 'Optional. The URL of the BYO LLM App Builder action. Set it when your LLM endpoint does not accept requests from a browser; requests then go through the action instead. See the README.',
      control: h('input', {
        type: 'url', value: settings.proxyUrl, autocomplete: 'off', spellcheck: 'false', placeholder: 'https://…/api/v1/web/byo-llm/generate', disabled: readOnly(),
      }),
    });

    const advanced = h('details', { class: 'advanced', open: !!settings.proxyUrl }, h('summary', { text: 'Advanced' }), proxy.el);
    const save = h('button', { type: 'submit', class: 'button-primary', text: 'Save', disabled: readOnly() });

    return h(
      'form',
      {
        class: 'settings-section',
        novalidate: true,
        onSubmit: async (event) => {
          event.preventDefault();
          const next = {
            ...settings,
            brandGuidelines: guidelines.control.value.trim(),
            proxyUrl: proxy.control.value.trim(),
          };
          const errors = validateSettings(next);
          proxy.setError(errors.proxyUrl);
          if (errors.proxyUrl) {
            advanced.open = true;
            proxy.control.focus();
            return;
          }
          save.disabled = true;
          const saved = await persist({ ...state.config, settings: next }, 'Saved.');
          if (saved) render();
          else save.disabled = false;
        },
      },
      h('h2', { text: 'Brand guidelines' }),
      guidelines.el,
      advanced,
      h('div', { class: 'form-actions' }, save),
    );
  }

  /* ---------- Page ---------- */

  function renderStorageNote() {
    const sheetUrl = `https://da.live/sheet#${store.path}`;
    return h(
      'section',
      { class: 'settings-section storage-note' },
      h('h2', { text: 'Where this is stored' }),
      h(
        'p',
        {},
        'These settings, including the API keys, are saved in the sheet ',
        h('a', { href: sheetUrl, target: '_blank', rel: 'noopener noreferrer', text: store.path }),
        ' in private tabs that Experience Workspace never previews or publishes.',
      ),
      h('p', { text: 'Anyone who can read that sheet can read the keys, and authors need read access to use the plugin. Use keys that are limited to this purpose, and restrict who can edit the sheet with Experience Workspace permissions.' }),
    );
  }

  function render() {
    if (state.status === 'loading') {
      setChildren(view, h('p', { class: 'loading', text: 'Loading settings…' }));
      return;
    }
    if (state.status === 'error') {
      setChildren(
        view,
        h(
          'div',
          { class: 'notice notice-error', role: 'alert' },
          icon('alert'),
          h('div', {}, h('p', { text: state.error }), state.retry && h('button', {
            type: 'button', class: 'button-secondary', text: 'Try again', onClick: load,
          })),
        ),
      );
      return;
    }
    setChildren(
      view,
      readOnly() && h('div', { class: 'notice' }, icon('alert'), h('p', { text: 'You can view these settings but you do not have permission to change them.' })),
      renderConnections(),
      renderGeneral(),
      renderStorageNote(),
    );
  }

  async function load() {
    state.status = 'loading';
    render();
    try {
      const { config, canWrite } = await store.load();
      state.config = config;
      state.canWrite = canWrite;
      state.status = 'ready';
    } catch (error) {
      state.status = 'error';
      state.error = error.message;
      state.retry = error.code !== 'forbidden';
    }
    render();
  }

  load();

  return {
    destroy() {
      clearTimeout(toastTimer);
      root.replaceChildren();
    },
  };
}
