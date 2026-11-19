/* Entry point of the BYO LLM settings app (fullscreen, for site admins). */

import connect, { showFatal } from './lib/bootstrap.js';
import mountSettings from './lib/settings-view.js';

const app = document.getElementById('app');

connect(app, { allowSiteFromHash: true })
  .then(({ context, getToken, store, fetch }) => {
    document.getElementById('site').textContent = `${context.org} / ${context.site}`;
    document.querySelector('.page-header').hidden = false;
    mountSettings(app, { store, context, getToken, fetch });
  })
  .catch((error) => showFatal(app, error));
