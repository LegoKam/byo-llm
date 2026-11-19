import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function filesUnder(dir) {
  const entries = await readdir(path.join(ROOT, dir), { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)));
}

/*
 * The plugin must run from this repository alone: no script, stylesheet, font or module
 * loaded from another host. (Calling Adobe's APIs and the configured LLM is the job, and
 * links in text are fine.)
 */
test('the shipped plugin loads nothing from another origin', async () => {
  const files = await filesUnder('plugin/tools');
  assert.ok(files.length > 10);

  for (const file of files) {
    const source = await readFile(path.join(ROOT, file), 'utf8');
    if (/\.(js|mjs)$/.test(file)) {
      const specifiers = [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g)].map((match) => match[2]);
      for (const specifier of specifiers) {
        assert.match(specifier, /^\.{1,2}\//, `${file} imports "${specifier}"`);
      }
    }
    if (file.endsWith('.html')) {
      const urls = [...source.matchAll(/<(?:script|link|img|iframe)\b[^>]*?\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
      for (const url of urls) {
        assert.ok(url.startsWith('./') || url.startsWith('data:'), `${file} loads "${url}"`);
      }
      assert.match(source, /Content-Security-Policy[^>]+script-src 'self'/, `${file} has no CSP`);
    }
    if (file.endsWith('.css')) {
      assert.ok(!/@import|url\(\s*['"]?(https?:)?\/\//.test(source), `${file} loads a remote resource`);
    }
  }
});

test('the project has no runtime dependencies', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  const action = JSON.parse(await readFile(path.join(ROOT, 'proxy/package.json'), 'utf8'));
  assert.equal(action.dependencies, undefined);
});

test('development and proxy code stay off the CDN', async () => {
  const ignored = (await readFile(path.join(ROOT, '.hlxignore'), 'utf8')).split('\n').map((line) => line.trim());
  for (const entry of ['proxy/', 'dev/', 'plugin/test/', 'guides/']) assert.ok(ignored.includes(entry), entry);
});

test('the marketplace entry points at this plugin', async () => {
  const row = JSON.parse(await readFile(path.join(ROOT, 'marketplace/row.json'), 'utf8'));
  for (const key of ['Title', 'Description', 'Category', 'Doc Url', 'Status', 'Owner', 'Type']) {
    assert.ok(row[key], `marketplace/row.json is missing "${key}"`);
  }
});

test('the settings app reads its site from a well-formed fragment only', async () => {
  globalThis.window ??= { parent: {}, addEventListener() {} };
  const { siteFromHash } = await import('../tools/byo-llm/lib/bootstrap.js');
  assert.deepEqual(siteFromHash('#/acme/my-site'), { org: 'acme', site: 'my-site' });
  assert.deepEqual(siteFromHash('#/acme/my-site/'), { org: 'acme', site: 'my-site' });
  for (const hash of ['', '#', '#/acme', '#/acme/', '#acme/site', '#/acme/site/extra', '#/../site', '#/acme/si te', '#/a/b?x=1', undefined]) {
    assert.equal(siteFromHash(hash), null, String(hash));
  }
});
