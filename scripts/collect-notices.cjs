'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const project = require('../package.json');
const seen = new Set(), entries = [];
function locate(name, from) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const file = path.join(directory, 'node_modules', name, 'package.json');
    if (fs.existsSync(file)) return file;
    if (path.dirname(directory) === directory) throw new Error('Missing dependency: ' + name);
  }
}
function visit(name, from) {
  const manifestPath = locate(name, from), directory = path.dirname(manifestPath), manifest = JSON.parse(fs.readFileSync(manifestPath));
  const identity = manifest.name + '@' + manifest.version;
  if (seen.has(identity)) return;
  seen.add(identity);
  const notices = fs.readdirSync(directory).filter(file => /^(?:licen[sc]e|copying|notice)(?:[.-]|$)/i.test(file) && fs.statSync(path.join(directory, file)).isFile());
  if (!notices.length) throw new Error('Dependency has no local license notice: ' + identity);
  entries.push('## ' + identity + '\n\nDeclared license: ' + manifest.license + '\n\n' + notices.map(file => '### ' + file + '\n\n```text\n' + fs.readFileSync(path.join(directory, file), 'utf8').trimEnd() + '\n```').join('\n\n'));
  for (const child of Object.keys(manifest.dependencies || {}).sort()) visit(child, directory);
}
for (const name of Object.keys(project.dependencies).sort()) visit(name, root);
const intro = '# Third-party notices\n\nThe project code is licensed under MIT. The following runtime components retain their own notices and licenses. Upstream legal notices are reproduced verbatim; they are not application configuration or maintainer contact information. Electron packages additionally include Electron and Chromium license files alongside the native executable. Development-only packages remain governed by their notices in node_modules.\n\n';
fs.writeFileSync(path.join(root, 'docs', 'THIRD-PARTY-NOTICES.md'), intro + entries.sort().join('\n\n---\n\n') + '\n');
console.log('Collected notices for ' + entries.length + ' runtime packages.');
