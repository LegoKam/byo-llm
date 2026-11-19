// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';

const status = document.getElementById('status');
const greeting = document.getElementById('greeting');
const buttons = {
  text: document.getElementById('send-text'),
  html: document.getElementById('send-html'),
  close: document.getElementById('send-close'),
};

function getGreeting() {
  return greeting.value.trim() || 'Hello, World!';
}

function toHeading(text) {
  // Build through the DOM so whatever the author typed is escaped.
  const h2 = document.createElement('h2');
  h2.textContent = text;
  return h2.outerHTML;
}

(async function init() {
  // DA_SDK only resolves once Experience Workspace has loaded this page in its
  // library iframe, so the buttons stay disabled when the page is opened directly.
  const { context, actions } = await DA_SDK;

  // The site is reported as `repo` or `site` depending on the host version.
  const { org, site, repo, path } = context ?? {};
  const location = [org, site || repo].filter(Boolean).join('/') + (path ?? '');
  status.textContent = location ? `Connected to ${location}` : 'Connected to Experience Workspace';

  buttons.text.addEventListener('click', () => {
    actions.sendText(getGreeting());
  });

  buttons.html.addEventListener('click', () => {
    actions.sendHTML(toHeading(getGreeting()));
  });

  buttons.close.addEventListener('click', () => {
    actions.sendText(getGreeting());
    actions.closeLibrary();
  });

  Object.values(buttons).forEach((button) => { button.disabled = false; });
}());
