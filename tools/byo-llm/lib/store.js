/*
 * Reads and writes the BYO LLM configuration sheet in the site's /.da folder, with the
 * signed-in user's own token. Whoever may read or write that sheet in DA may read or
 * write the configuration; there is no other access control.
 */

import { SECRET_PATH, emptyConfig, parseSheet, toSheet } from './config-model.js';

export const DEFAULT_ORIGINS = {
  daAdmin: 'https://admin.da.live',
  hlxAdmin: 'https://admin.hlx.page',
  aemApi: 'https://api.aem.live',
};

export class StoreError extends Error {
  /** @param {string} code One of: unauthenticated, forbidden, network, failed. */
  constructor(code, message, status) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Wraps fetch so every request carries the user's IMS token.
 * @param {() => string} getToken Called per request, so a refreshed token is picked up.
 */
export function createAuthedFetch(getToken, { fetch = globalThis.fetch, origins = DEFAULT_ORIGINS } = {}) {
  return (url, opts = {}) => {
    const token = getToken();
    const headers = { ...opts.headers };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      // The AEM admin APIs read the content source (DA) with this second header.
      if (url.startsWith(origins.hlxAdmin) || url.startsWith(origins.aemApi)) {
        headers['x-content-source-authorization'] = `Bearer ${token}`;
      }
    }
    return fetch(url, { ...opts, headers });
  };
}

function errorFor(status, action) {
  if (status === 401) return new StoreError('unauthenticated', 'Your Experience Workspace session has expired. Reload the page and sign in again.', status);
  if (status === 403) {
    return new StoreError('forbidden', action === 'save'
      ? 'You do not have permission to change the BYO LLM settings of this site.'
      : 'You do not have permission to read the BYO LLM settings of this site.', status);
  }
  return new StoreError('failed', `Could not ${action} the BYO LLM settings (${status}).`, status);
}

// DA reports what the caller may do with a path, e.g. "x-da-actions: /org/site/.da=read,write".
function canWriteFrom(resp) {
  const header = resp.headers.get('x-da-actions');
  if (!header) return undefined;
  return header.split('=').pop().split(',').map((action) => action.trim()).includes('write');
}

/**
 * @param {object} options
 * @param {string} options.org
 * @param {string} options.site
 * @param {Function} options.fetch An authenticated fetch (see createAuthedFetch).
 * @param {Function} [options.plainFetch] An unauthenticated fetch, for the public ping.
 * @param {object} [options.origins]
 */
export function createStore({
  org, site, fetch, plainFetch = globalThis.fetch, origins = DEFAULT_ORIGINS,
}) {
  if (!org || !site) throw new StoreError('failed', 'BYO LLM needs an organisation and a site.');
  const orgPart = encodeURIComponent(org);
  const sitePart = encodeURIComponent(site);

  // Sites upgraded to the AEM API ("Helix 6") keep their source there instead of in DA admin.
  // The admin ping marks them with a response header.
  let upgraded;
  const isUpgraded = () => {
    upgraded ??= Promise.resolve()
      .then(() => plainFetch(`${origins.hlxAdmin}/ping/${orgPart}/${sitePart}`))
      .then((resp) => resp.headers.get('x-api-upgrade-available') !== null)
      .catch(() => false);
    return upgraded;
  };

  const sourceUrl = async () => ((await isUpgraded())
    ? `${origins.aemApi}/${orgPart}/sites/${sitePart}/source${SECRET_PATH}`
    : `${origins.daAdmin}/source/${orgPart}/${sitePart}${SECRET_PATH}`);

  const request = async (url, opts) => {
    try {
      return await fetch(url, opts);
    } catch {
      throw new StoreError('network', 'Could not reach Experience Workspace. Check your connection and try again.');
    }
  };

  return {
    path: `/${org}/${site}${SECRET_PATH.replace(/\.json$/, '')}`,

    /** @returns {Promise<{ exists: boolean, config: object, canWrite: boolean|undefined }>} */
    async load() {
      const resp = await request(await sourceUrl(), { cache: 'no-store' });
      const canWrite = canWriteFrom(resp);
      if (resp.status === 404) return { exists: false, config: emptyConfig(), canWrite };
      if (!resp.ok) throw errorFor(resp.status, 'load');
      let json;
      try {
        json = await resp.json();
      } catch {
        throw new StoreError('failed', 'The BYO LLM settings sheet is not valid JSON.');
      }
      return { exists: true, config: parseSheet(json), canWrite };
    },

    async save(config) {
      const body = JSON.stringify(toSheet(config));
      const url = await sourceUrl();
      let opts;
      if (await isUpgraded()) {
        opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
      } else {
        const form = new FormData();
        form.append('data', new Blob([body], { type: 'application/json' }));
        opts = { method: 'POST', body: form };
      }
      const resp = await request(url, opts);
      if (!resp.ok) throw errorFor(resp.status, 'save');
    },
  };
}
