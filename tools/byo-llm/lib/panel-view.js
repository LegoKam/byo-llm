/*
 * The plugin panel: pick up the editor selection, ask the organisation's LLM, preview the
 * answer, put it into the document.
 */

import { h, icon, setChildren } from './dom.js';
import { PROVIDERS, findConnection, getDefaultConnection } from './config-model.js';
import {
  LANGUAGES, MAX_SELECTION_CHARS, PRESETS, buildRefineRequest, buildRequest, translateInstruction,
} from './prompt.js';
import { ACCEPT, checkFile, formatBytes, readAttachment } from './attachments.js';
import { htmlToText, imageSources, modelOutputToHtml, singleTextBlock } from './html.js';
import { generate } from './llm.js';
import mountSettings from './settings-view.js';

const SELECTION_PREVIEW_CHARS = 280;

function remember(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked in a third-party iframe. The picker then starts at the default.
  }
  return null;
}

/**
 * @param {HTMLElement} root
 * @param {object} options
 * @param {{ org: string, site: string }} options.context
 * @param {object} options.actions `getSelection`, `sendHTML`, `sendText` from the SDK.
 * @param {() => string} options.getToken
 * @param {object} options.store From createStore.
 * @param {Function} [options.fetch] Used for LLM calls.
 * @returns {{ destroy: () => void }}
 */
export default function mountPanel(root, {
  context, actions, getToken, store, fetch,
}) {
  const storageKey = `byo-llm:connection:${context.org}/${context.site}`;
  const state = {
    configStatus: 'loading', // loading | ready | error
    configError: null,
    config: null,
    canWrite: undefined,
    connectionName: '',
    selectionHtml: '',
    attachments: [],
    run: null, // { status: running|done|error, request, selectionHtml, ... }
  };
  let settings = null;
  let elapsedTimer;

  /* ---------- Elements ---------- */

  const picker = h('select', { class: 'model-picker', 'aria-label': 'Model', hidden: true });
  const settingsButton = h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Settings', title: 'Settings' }, icon('settings'));
  const backButton = h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Back', title: 'Back', hidden: true }, icon('back'));
  const title = h('h1', { text: 'BYO LLM' });
  const header = h('header', { class: 'panel-header' }, backButton, h('div', { class: 'panel-title' }, icon('sparkle'), title), picker, settingsButton);

  const configNotice = h('div', { class: 'config-notice' });

  const selectionText = h('p', { class: 'selection-text' });
  const refreshButton = h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Refresh selection', title: 'Refresh selection' }, icon('refresh'));
  const selectionCard = h('section', { class: 'selection-card', 'aria-label': 'Selected content' }, h('div', { class: 'selection-head' }, h('h2', { text: 'Selection' }), refreshButton), selectionText);

  const presetButtons = PRESETS.map((preset) => h('button', {
    type: 'button', class: 'chip', text: preset.label, dataset: { preset: preset.id },
  }));
  const translate = h(
    'select',
    { class: 'chip chip-select', 'aria-label': 'Translate the selection' },
    h('option', { value: '', text: 'Translate…' }),
    ...LANGUAGES.map((language) => h('option', { value: language, text: language })),
  );
  const quickHint = h('p', { class: 'hint-inline', role: 'status' });
  const quickActions = h('section', { class: 'quick-actions', 'aria-label': 'Quick actions' }, h('div', { class: 'chips' }, ...presetButtons, translate), quickHint);

  const prompt = h('textarea', {
    id: 'byo-prompt', rows: 3, placeholder: 'Describe what to write, or how to change the selection…',
  });
  const attachmentList = h('ul', { class: 'attachment-list' });
  const attachError = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const fileInput = h('input', { type: 'file', multiple: true, accept: ACCEPT, hidden: true, tabindex: '-1' });
  const attachButton = h('button', { type: 'button', class: 'button-quiet attach-button' }, icon('attach'), 'Attach files');
  const generateButton = h('button', { type: 'submit', class: 'button-primary', text: 'Generate' });
  const promptForm = h(
    'form',
    { class: 'prompt-form' },
    h('label', { for: 'byo-prompt', class: 'visually-hidden', text: 'Your instruction' }),
    prompt,
    attachmentList,
    attachError,
    h('div', { class: 'prompt-actions' }, attachButton, fileInput, generateButton),
  );

  const result = h('section', { class: 'result', 'aria-live': 'polite', hidden: true });
  const compose = h('main', { class: 'compose' }, configNotice, selectionCard, quickActions, promptForm, result);
  const settingsHost = h('main', { class: 'settings-host', hidden: true });
  const panel = h('div', { class: 'panel' }, header, compose, settingsHost);
  root.replaceChildren(panel);

  /* ---------- Configuration ---------- */

  const currentConnection = () => state.config
    && (findConnection(state.config, state.connectionName) || getDefaultConnection(state.config));

  const isReady = () => state.configStatus === 'ready' && !!currentConnection();

  function renderControls() {
    const running = state.run?.status === 'running';
    const usable = isReady() && !running;
    generateButton.disabled = !usable;
    translate.disabled = !usable;
    presetButtons.forEach((button) => { button.disabled = !usable; });
  }

  function renderConfig() {
    const connections = state.config?.connections || [];
    picker.hidden = connections.length === 0;
    setChildren(picker, connections.map((conn) => h('option', { value: conn.name, text: conn.name })));
    const connection = currentConnection();
    if (connection) picker.value = connection.name;

    if (state.configStatus === 'loading') {
      setChildren(configNotice, h('p', { class: 'loading', text: 'Loading…' }));
    } else if (state.configStatus === 'error') {
      const { code, message } = state.configError;
      setChildren(configNotice, h(
        'div',
        { class: 'notice notice-error', role: 'alert' },
        icon('alert'),
        h(
          'div',
          {},
          h('p', { text: code === 'forbidden' ? `${message} Ask a site admin for read access to ${store.path}.` : message }),
          code !== 'forbidden' && h('button', { type: 'button', class: 'button-secondary', text: 'Try again', onClick: loadConfig }),
        ),
      ));
    } else if (!connections.length) {
      setChildren(configNotice, h(
        'div',
        { class: 'notice' },
        icon('alert'),
        h(
          'div',
          {},
          h('p', { text: state.canWrite === false
            ? 'No LLM is connected to this site yet. Ask a site admin to add one in the BYO LLM settings.'
            : 'No LLM is connected to this site yet. Add your organisation\'s model to get started.' }),
          state.canWrite !== false && h('button', { type: 'button', class: 'button-primary', text: 'Open settings', onClick: openSettings }),
        ),
      ));
    } else {
      setChildren(configNotice);
    }
    renderControls();
  }

  async function loadConfig() {
    state.configStatus = 'loading';
    renderConfig();
    try {
      const { config, canWrite } = await store.load();
      state.config = config;
      state.canWrite = canWrite;
      state.connectionName = remember(storageKey) || '';
      state.configStatus = 'ready';
    } catch (error) {
      state.configStatus = 'error';
      state.configError = { code: error.code, message: error.message };
    }
    renderConfig();
  }

  /* ---------- Selection ---------- */

  function renderSelection() {
    const text = htmlToText(state.selectionHtml);
    if (!text) {
      selectionText.className = 'selection-text selection-empty';
      selectionText.textContent = 'Nothing selected. Select content in the document to rewrite it, or describe what to write and it goes in at the cursor.';
      return;
    }
    selectionText.className = 'selection-text';
    selectionText.textContent = text.length > SELECTION_PREVIEW_CHARS
      ? `${text.slice(0, SELECTION_PREVIEW_CHARS).trimEnd()}…`
      : text;
  }

  async function refreshSelection() {
    state.selectionHtml = await actions.getSelection();
    renderSelection();
    renderInsertLabel();
    return state.selectionHtml;
  }

  /* ---------- Attachments ---------- */

  function showAttachError(message) {
    attachError.textContent = message || '';
    attachError.hidden = !message;
  }

  function renderAttachments() {
    setChildren(attachmentList, state.attachments.map((file, index) => h(
      'li',
      { class: 'attachment' },
      icon(file.kind === 'image' ? 'image' : 'text'),
      h('span', { class: 'attachment-name', text: file.name, title: file.name }),
      h('span', { class: 'attachment-size', text: file.truncated ? 'shortened' : formatBytes(file.size) }),
      h('button', {
        type: 'button',
        class: 'icon-button icon-button-small',
        'aria-label': `Remove ${file.name}`,
        onClick: () => { state.attachments.splice(index, 1); showAttachError(''); renderAttachments(); },
      }, icon('close')),
    )));
  }

  async function addFiles(files) {
    showAttachError('');
    const errors = [];
    // One at a time, so the count limit applies while files are still being read.
    for (const file of files) {
      const check = checkFile(file, { count: state.attachments.length });
      if (check.error) {
        errors.push(check.error);
      } else if (state.attachments.some((existing) => existing.name === file.name)) {
        errors.push(`${file.name} is already attached.`);
      } else {
        try {
          state.attachments.push(await readAttachment(file, check.kind));
        } catch {
          errors.push(`${file.name} could not be read.`);
        }
      }
    }
    renderAttachments();
    // Show each distinct problem once ("up to 5 files" would otherwise repeat per extra file).
    showAttachError([...new Set(errors)].join(' '));
  }

  /* ---------- Result ---------- */

  let insertButton;

  function renderInsertLabel() {
    if (!insertButton || insertButton.dataset.done) return;
    insertButton.textContent = state.selectionHtml ? 'Replace selection' : 'Insert at cursor';
  }

  function flash(button, text) {
    const label = button.textContent;
    button.dataset.done = 'true';
    button.textContent = text;
    setTimeout(() => {
      delete button.dataset.done;
      button.textContent = label;
      if (button === insertButton) renderInsertLabel();
    }, 1600);
  }

  async function insertResult() {
    const { html } = state.run;
    // The author may have moved the cursor since generating, so look again.
    const current = await refreshSelection();
    const target = singleTextBlock(current);
    const answer = singleTextBlock(html);
    // Text for text inside one paragraph or heading: the editor then keeps that block whole.
    // Sending a block instead would split a paragraph when only part of it is selected.
    if (target && answer && answer.plain && answer.tag === target.tag) actions.sendText(answer.text);
    else actions.sendHTML(html);
    flash(insertButton, current ? 'Replaced' : 'Inserted');
  }

  async function copyResult(preview, button) {
    const { html } = state.run;
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([htmlToText(html)], { type: 'text/plain' }),
      })]);
    } catch {
      // The async clipboard is often not allowed in an embedded panel. Copying a selection is.
      const range = document.createRange();
      range.selectNodeContents(preview);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('copy');
      selection.removeAllRanges();
    }
    flash(button, 'Copied');
  }

  function renderResult() {
    clearInterval(elapsedTimer);
    insertButton = undefined;
    const { run } = state;
    result.hidden = !run;
    renderControls();
    if (!run) {
      setChildren(result);
      return;
    }

    if (run.status === 'running') {
      const elapsed = h('span', { class: 'elapsed' });
      const tick = () => { elapsed.textContent = `${Math.round((Date.now() - run.started) / 1000)} s`; };
      tick();
      elapsedTimer = setInterval(tick, 1000);
      setChildren(result, h(
        'div',
        { class: 'progress' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        h('p', {}, `Asking ${run.connectionName}… `, elapsed),
        h('button', { type: 'button', class: 'button-quiet', text: 'Cancel', onClick: () => run.controller.abort() }),
      ));
      return;
    }

    if (run.status === 'error') {
      setChildren(result, h(
        'div',
        { class: 'notice notice-error', role: 'alert' },
        icon('alert'),
        h(
          'div',
          {},
          h('p', { text: run.error.message }),
          h(
            'div',
            { class: 'notice-actions' },
            // A request that failed our own checks was never built, so there is nothing to retry.
            run.request && h('button', { type: 'button', class: 'button-secondary', text: 'Try again', onClick: () => execute(run.request, run) }),
            ['auth', 'not-found'].includes(run.error.code) && state.canWrite !== false
              && h('button', { type: 'button', class: 'button-quiet', text: 'Open settings', onClick: openSettings }),
          ),
        ),
      ));
      return;
    }

    const preview = h('div', { class: 'result-preview' });
    // run.html went through the allowlist sanitizer in html.js.
    preview.innerHTML = run.html;
    preview.addEventListener('click', (event) => {
      if (event.target.closest('a')) event.preventDefault();
    });

    const meta = [run.model];
    if (run.usage?.inputTokens !== undefined && run.usage?.outputTokens !== undefined) {
      meta.push(`${run.usage.inputTokens} + ${run.usage.outputTokens} tokens`);
    }

    insertButton = h('button', { type: 'button', class: 'button-primary', onClick: insertResult });
    const copyButton = h('button', { type: 'button', class: 'button-secondary', onClick: () => copyResult(preview, copyButton) }, 'Copy');
    const refineInput = h('input', {
      type: 'text', id: 'byo-refine', placeholder: 'Ask for a change, e.g. "more formal"', autocomplete: 'off',
    });

    setChildren(
      result,
      h('div', { class: 'result-head' }, h('h2', { text: run.label }), h('p', { class: 'result-meta', text: meta.filter(Boolean).join(' · ') })),
      preview,
      run.truncated && h('p', { class: 'hint-inline hint-warning', text: 'The answer was cut off at the model\'s length limit.' }),
      h(
        'div',
        { class: 'result-actions' },
        insertButton,
        copyButton,
        h('button', { type: 'button', class: 'button-quiet', text: 'Try again', onClick: () => execute(run.request, run) }),
      ),
      h(
        'form',
        {
          class: 'refine',
          onSubmit: (event) => {
            event.preventDefault();
            const change = refineInput.value.trim();
            if (!change) { refineInput.focus(); return; }
            execute(buildRefineRequest(run.request, run.raw, change), { ...run, label: 'Refined' });
          },
        },
        h('label', { for: 'byo-refine', class: 'visually-hidden', text: 'Ask for a change' }),
        refineInput,
        h('button', { type: 'submit', class: 'button-secondary', text: 'Refine' }),
      ),
    );
    renderInsertLabel();
  }

  /* ---------- Running a request ---------- */

  async function execute(request, { selectionHtml, label }) {
    const connection = currentConnection();
    if (!connection) return;
    const controller = new AbortController();
    const base = {
      request, selectionHtml, label, connectionName: connection.name,
    };
    state.run = {
      ...base, status: 'running', controller, started: Date.now(),
    };
    renderResult();

    try {
      const answer = await generate({
        config: state.config,
        connection,
        request,
        context,
        token: getToken(),
        fetch,
        signal: controller.signal,
      });
      const html = modelOutputToHtml(answer.text, { allowedImages: imageSources(selectionHtml) });
      if (!html) throw Object.assign(new Error('The model answered, but with nothing that can go into the document. Try again or rephrase the request.'), { code: 'bad-response' });
      state.run = {
        ...base, status: 'done', raw: answer.text, html, model: answer.model, usage: answer.usage, truncated: answer.truncated,
      };
    } catch (error) {
      state.run = error.code === 'aborted'
        ? null
        : { ...base, status: 'error', error: { code: error.code, message: error.message || 'Something went wrong.' } };
    }
    renderResult();
    if (state.run) result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  async function run({ instruction, label, needsSelection }) {
    if (!isReady() || state.run?.status === 'running') return;
    quickHint.textContent = '';
    const connection = currentConnection();
    const selectionHtml = await refreshSelection();

    if (needsSelection && !selectionHtml) {
      quickHint.textContent = 'Select content in the document first, then choose a quick action.';
      return;
    }
    const fail = (message) => {
      state.run = {
        status: 'error', request: null, selectionHtml, label, connectionName: connection.name, error: { code: 'invalid', message },
      };
      renderResult();
    };
    if (selectionHtml.length > MAX_SELECTION_CHARS) {
      fail('The selection is too large to send. Select a smaller part of the document.');
      return;
    }
    if (!PROVIDERS[connection.provider]?.pdf && state.attachments.some((file) => file.kind === 'pdf')) {
      fail(`"${connection.name}" can't read PDF files. Remove the PDF, or attach its content as text or as an image.`);
      return;
    }

    const request = buildRequest({
      instruction,
      selectionHtml,
      attachments: state.attachments,
      brandGuidelines: state.config.settings.brandGuidelines,
    });
    await execute(request, { selectionHtml, label });
  }

  /* ---------- Settings ---------- */

  function showView(name) {
    const inSettings = name === 'settings';
    compose.hidden = inSettings;
    settingsHost.hidden = !inSettings;
    backButton.hidden = !inSettings;
    settingsButton.hidden = inSettings;
    picker.hidden = inSettings || !(state.config?.connections.length);
    title.textContent = inSettings ? 'Settings' : 'BYO LLM';
  }

  function openSettings() {
    if (settings) return;
    showView('settings');
    settings = mountSettings(settingsHost, {
      store,
      context,
      getToken,
      fetch,
      onChange: (config) => { state.config = config; },
    });
    backButton.focus();
  }

  function closeSettings() {
    settings?.destroy();
    settings = null;
    showView('compose');
    // Reload rather than trust onChange alone: it also picks up the first save of a new sheet.
    loadConfig();
    settingsButton.focus();
  }

  /* ---------- Events ---------- */

  const onWindowFocus = () => { refreshSelection(); };
  window.addEventListener('focus', onWindowFocus);

  settingsButton.addEventListener('click', openSettings);
  backButton.addEventListener('click', closeSettings);
  refreshButton.addEventListener('click', refreshSelection);
  picker.addEventListener('change', () => {
    state.connectionName = picker.value;
    remember(storageKey, picker.value);
  });

  presetButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const preset = PRESETS.find(({ id }) => id === button.dataset.preset);
      run({ instruction: preset.instruction, label: preset.label, needsSelection: true });
    });
  });
  translate.addEventListener('change', () => {
    const language = translate.value;
    translate.value = '';
    if (language) run({ instruction: translateInstruction(language), label: `Translate into ${language}`, needsSelection: true });
  });

  promptForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const instruction = prompt.value.trim();
    if (!instruction) { prompt.focus(); return; }
    run({ instruction, label: 'Result' });
  });
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      promptForm.requestSubmit();
    }
  });

  attachButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    await addFiles([...fileInput.files]);
    fileInput.value = '';
  });
  const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
  compose.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    compose.classList.add('dropping');
  });
  compose.addEventListener('dragleave', (event) => {
    if (!compose.contains(event.relatedTarget)) compose.classList.remove('dropping');
  });
  compose.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    compose.classList.remove('dropping');
    addFiles([...event.dataTransfer.files]);
  });

  /* ---------- Start ---------- */

  renderSelection();
  renderAttachments();
  loadConfig();
  refreshSelection();

  return {
    destroy() {
      clearInterval(elapsedTimer);
      window.removeEventListener('focus', onWindowFocus);
      state.run?.controller?.abort();
      settings?.destroy();
      root.replaceChildren();
    },
  };
}
