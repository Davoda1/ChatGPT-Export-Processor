'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let cached;
const digest = text => crypto.createHash('sha256').update(text).digest('base64');
const safeScript = text => text.replace(/<\/script/gi, '<\\/script');

function packageRoot(name) {
  let directory = path.dirname(require.resolve(name));
  for (;;) {
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate the installed ${name} package.`);
    directory = parent;
  }
}

function license(root) {
  const name = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find(candidate => fs.existsSync(path.join(root, candidate)));
  if (!name) throw new Error('A required dependency license is missing.');
  return fs.readFileSync(path.join(root, name), 'utf8');
}

// highlight.js publishes CommonJS source. A deterministic static module wrapper
// retains its common language set without eval, external scripts, or build tools.
function highlightBundle(root) {
  const modules = new Map();
  function visit(file) {
    const absolute = path.resolve(file);
    if (!absolute.startsWith(root + path.sep)) throw new Error('Invalid highlighter module path.');
    const id = path.relative(root, absolute).replaceAll(path.sep, '/');
    if (modules.has(id)) return id;
    modules.set(id, '');
    const body = fs.readFileSync(absolute, 'utf8').replace(/require\((['"])([^'"]+)\1\)/g, (_, quote, dependency) => {
      if (!dependency.startsWith('.')) throw new Error('Unsupported highlighter dependency.');
      const target = path.resolve(path.dirname(absolute), dependency);
      return `load(${JSON.stringify(visit(path.extname(target) ? target : target + '.js'))})`;
    });
    modules.set(id, body);
    return id;
  }
  const entry = visit(path.join(root, 'lib', 'common.js'));
  const factories = [...modules].map(([id, body]) => `${JSON.stringify(id)}:function(module,exports,load){\n${body}\n}`).join(',\n');
  return `(function(){'use strict';const factories={${factories}};const cache=Object.create(null);function load(id){if(cache[id])return cache[id].exports;const module={exports:{}};cache[id]=module;factories[id](module,module.exports,load);return module.exports;}window.hljs=load(${JSON.stringify(entry)});})();`;
}

function getShell() {
  if (cached) return cached;
  const roots = Object.fromEntries(['marked', 'dompurify', 'highlight.js'].map(name => [name, packageRoot(name)]));
  const dependencies = [
    fs.readFileSync(path.join(roots.marked, 'lib', 'marked.umd.js'), 'utf8'),
    fs.readFileSync(path.join(roots.dompurify, 'dist', 'purify.min.js'), 'utf8'),
    highlightBundle(roots['highlight.js']),
  ];
  const libraries = safeScript(dependencies.join('\n;\n'));
  const client = safeScript(fs.readFileSync(path.join(__dirname, 'viewer.js'), 'utf8'));
  const css = fs.readFileSync(path.join(__dirname, 'viewer.css'), 'utf8');
  const notices = JSON.stringify(Object.entries(roots).map(([name, root]) => ({name, license: license(root)}))).replaceAll('<', '\\u003c');
  const policy = `default-src 'none'; script-src 'sha256-${digest(libraries)}' 'sha256-${digest(client)}'; style-src 'sha256-${digest(css)}'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
  const prefix = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<meta http-equiv="Content-Security-Policy" content="${policy}">\n<meta name="generator" content="ChatGPT Export Processor 1.0.0">\n<title>ChatGPT Archive</title>\n<style>${css}</style>\n</head>\n<body>\n<header class="toolbar"><div class="brand"><span class="mark" aria-hidden="true">▤</span><div><strong>ChatGPT Archive</strong><small>Your saved conversations · offline viewer</small></div></div><label class="search-label"><span class="sr-only">Search titles and messages</span><input id="search" type="search" placeholder="Search titles and messages…" autocomplete="off"></label><label class="theme-label"><span class="sr-only">Appearance</span><select id="theme"><option value="system">System theme</option><option value="dark">Dark theme</option><option value="light">Light theme</option></select></label></header>\n<div class="controls"><p id="summary" role="status" aria-live="polite">Loading saved conversations…</p><div class="actions"><label><span class="sr-only">Saved messages</span><select id="branch"><option value="current">Current branch</option><option value="all">All saved messages</option></select></label><button id="expand">Expand page</button><button id="collapse">Collapse page</button></div></div>\n<main id="archive" tabindex="-1" aria-label="Saved conversations"></main>\n<footer><span class="privacy">Offline · remote images are not loaded</span><button id="licenses" class="link-button">Open-source licenses</button><nav class="pagination" aria-label="Conversation pages"><button id="previous" aria-label="Previous page">Previous</button><span id="page-label">Page 1</span><button id="next" aria-label="Next page">Next</button></nav></footer>\n<dialog id="license-dialog" aria-labelledby="license-title"><div class="dialog-head"><h2 id="license-title">Open-source licenses</h2><button id="close-licenses" aria-label="Close licenses">Close</button></div><div id="license-body"></div></dialog>\n<script type="text/plain" id="archive-data">var jsonData = `;
  const suffix = `;</script>\n<script type="application/json" id="license-data">${notices}</script>\n<script>${libraries}</script>\n<script>${client}</script>\n</body>\n</html>\n`;
  cached = Object.freeze({prefix, suffix});
  return cached;
}

module.exports = {getShell};
