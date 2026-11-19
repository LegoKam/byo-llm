/*
 * Shared start-up for the plugin panel and the settings app: wait for Experience Workspace,
 * then build the store on the signed-in user's token.
 */

import DA_SDK from './da-sdk.js';
import { DEFAULT_ORIGINS, createAuthedFetch, createStore } from './store.js';

const HOST_WAIT = 5000;

// Local development: `?mock-da` on localhost points the store at the dev server's fake DA
// admin (see dev/server.mjs). It is ignored on every other host, so no link can make a
// deployed plugin send a real token anywhere but Adobe's APIs.
function resolveOrigins() {
  const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (local && new URLSearchParams(window.location.search).has('mock-da')) {
    const base = `${window.location.origin}/mock/da`;
    return { daAdmin: base, hlxAdmin: base, aemApi: base };
  }
  return DEFAULT_ORIGINS;
}

/**
 * A fullscreen app is told which repository its code comes from, not which site it should
 * work on. When this plugin is hosted in its own repository those differ, so the settings app
 * takes the site from the URL fragment, the way da.live's own tools do: `#/{org}/{site}`.
 */
export function siteFromHash(hash) {
  const match = String(hash || '').match(/^#\/([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)\/?$/);
  return match ? { org: match[1], site: match[2] } : null;
}

/**
 * @param {HTMLElement} app The element holding the initial "Connecting…" message.
 * @param {object} [options]
 * @param {boolean} [options.allowSiteFromHash] Let `#/{org}/{site}` choose the site (settings app only).
 * @returns {Promise<{ context: object, actions: object, getToken: Function, store: object, fetch: Function }>}
 */
export default async function connect(app, { allowSiteFromHash = false } = {}) {
  const waiting = setTimeout(() => {
    app.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'loading',
      textContent: 'Still waiting for Experience Workspace. This page is a plugin: open it from the editor in Experience Workspace rather than directly.',
    }));
  }, HOST_WAIT);

  const sdk = await DA_SDK;
  clearTimeout(waiting);
  const { actions, getToken } = sdk;
  // The fragment only picks which site to show. Reading and saving still happen with the
  // user's own sign-in, so it gives access to nothing they could not open in da.live.
  const target = allowSiteFromHash ? siteFromHash(window.location.hash) : null;
  const context = target ? { ...sdk.context, ...target } : sdk.context;

  if (!context.org || !context.site) {
    throw new Error('Experience Workspace did not say which site this is. Open the plugin from a site in Experience Workspace.');
  }

  const fetch = (...args) => window.fetch(...args);
  const origins = resolveOrigins();
  const store = createStore({
    org: context.org,
    site: context.site,
    origins,
    fetch: createAuthedFetch(getToken, { fetch, origins }),
    plainFetch: fetch,
  });

  return { context, actions, getToken, store, fetch };
}

export function showFatal(app, error) {
  app.replaceChildren(Object.assign(document.createElement('p'), {
    className: 'loading',
    textContent: error.message,
  }));
}
