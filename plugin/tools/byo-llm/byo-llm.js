/* Entry point of the BYO LLM library plugin (the side panel in the editor). */

import connect, { showFatal } from './lib/bootstrap.js';
import mountPanel from './lib/panel-view.js';

const app = document.getElementById('app');

connect(app)
  .then((host) => mountPanel(app, host))
  .catch((error) => showFatal(app, error));
