/*
 * Local client for the Experience Workspace App SDK.
 *
 * Experience Workspace loads a plugin or app in an iframe and, once it has loaded, posts one
 * `{ ready: true, context, token, capabilities }` message that carries a MessagePort. All
 * further calls (insert content, read the selection, close the panel) go over that port.
 *
 * This file implements that protocol so the project has no runtime dependency on a script
 * hosted elsewhere. It follows Adobe's hosted SDK (https://da.live/nx/utils/sdk.js, source in
 * adobe/da-nx, Apache-2.0) and covers the calls this plugin uses.
 */

const REQUEST_TIMEOUT = 15000;

function createActions(port) {
  const post = (action, details) => {
    try {
      port.postMessage(details === undefined ? { action } : { action, details });
    } catch {
      // The host closed the panel; there is nobody to tell.
    }
  };

  // Request/response over the port: the host answers with `sdkResponse` and the same requestId.
  const request = (action) => new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    let timer;
    const finish = (result) => {
      clearTimeout(timer);
      port.removeEventListener('message', onMessage);
      resolve(result);
    };
    function onMessage({ data }) {
      if (data?.action !== 'sdkResponse' || data.requestId !== requestId) return;
      finish(typeof data.result?.ok === 'boolean' ? data.result : { ok: false, error: 'invalid-response' });
    }
    timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), REQUEST_TIMEOUT);
    try {
      port.addEventListener('message', onMessage);
      port.start();
      port.postMessage({ action, requestId });
    } catch {
      finish({ ok: false, error: 'disconnected' });
    }
  });

  return {
    /** Replaces the editor selection with text, staying inside the current paragraph. */
    sendText: (text) => post('sendText', text),
    /** Replaces the editor selection with HTML, or inserts it at the cursor. */
    sendHTML: (html) => post('sendHTML', html),
    closeLibrary: () => post('closeLibrary'),
    setTitle: (title) => post('setTitle', title),
    /**
     * @returns {Promise<string>} The editor selection as HTML, or '' when nothing is selected
     *  or there is no editor (a fullscreen app).
     */
    getSelection: async () => {
      const result = await request('getSelection');
      return result.ok && typeof result.html === 'string' ? result.html : '';
    },
  };
}

/**
 * Resolves once Experience Workspace has introduced itself.
 * @type {Promise<{
 *   context: { org: string, site: string, repo: string, path: string, ref: string, view: string },
 *   capabilities: object,
 *   actions: ReturnType<typeof createActions>,
 *   getToken: () => string,
 * }>}
 */
const DA_SDK = new Promise((resolve) => {
  let token;
  let initialized = false;

  window.addEventListener('message', (event) => {
    // Only the embedding page may initialise the plugin or refresh its token.
    if (!event.data || event.source !== window.parent) return;

    // Requiring `ready` and a port ignores the stray messages that browser extensions post.
    if (!initialized && event.data.ready && event.ports?.length) {
      initialized = true;
      token = event.data.token;
      const [port] = event.ports;
      const actions = createActions(port);
      actions.setTitle(document.title);

      const raw = event.data.context || event.data.project || {};
      // Fullscreen apps get `repo` only; the editor sends both.
      const context = { ...raw, site: raw.site || raw.repo };

      resolve({
        context,
        capabilities: event.data.capabilities || {},
        actions,
        getToken: () => token,
      });
      return;
    }

    // The host posts again when it refreshes the IMS token.
    if (initialized && event.data.token) token = event.data.token;
  });
});

export default DA_SDK;
