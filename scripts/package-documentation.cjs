'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {lexer, walkTokens} = require('marked');

// Copy only reviewed publication files, keeping README and gallery links valid.
const documentationFiles = Object.freeze([
  'README.md', 'SECURITY.md', 'CONTRIBUTING.md',
  'docs/BUILDING.md', 'docs/CI.md', 'docs/THIRD-PARTY-NOTICES.md',
  'docs/extras/README.md',
  'docs/extras/overview-dark.png', 'docs/extras/overview-light.png',
  'docs/extras/findings-dark.png', 'docs/extras/findings-light.png',
  'docs/extras/schema-dark.png', 'docs/extras/schema-light.png',
]);

function verifyDocumentation(directory) {
  const root = path.resolve(directory);
  let localLinks = 0;
  for (const name of documentationFiles) {
    const file = path.join(root, ...name.split('/'));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size === 0) throw new Error('Packaged documentation must be a nonempty regular file: ' + name);
    if (!name.endsWith('.md')) continue;
    walkTokens(lexer(fs.readFileSync(file, 'utf8')), token => {
      if (!['link', 'image'].includes(token.type)) return;
      const href = token.href;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return;
      const relative = decodeURIComponent(href.split(/[?#]/)[0]);
      if (!relative) return;
      const target = path.resolve(path.dirname(file), relative);
      const withinRoot = path.relative(root, target);
      if (path.isAbsolute(relative) || path.isAbsolute(withinRoot) || withinRoot === '..' || withinRoot.startsWith('..' + path.sep)) throw new Error('Packaged documentation link leaves its directory tree: ' + name);
      let targetStat;
      try {targetStat = fs.lstatSync(target);} catch (error) {if (error.code !== 'ENOENT') throw error;}
      if (!targetStat?.isFile()) throw new Error('Packaged documentation has a missing local link target: ' + name);
      localLinks++;
    });
  }
  return {files: documentationFiles.length, localLinks};
}

async function copyDocumentation(source, destination) {
  for (const name of documentationFiles) {
    const input = path.join(source, ...name.split('/')), output = path.join(destination, ...name.split('/'));
    if (!(await fsp.lstat(input)).isFile()) throw new Error('Publication documentation source must be a regular file: ' + name);
    await fsp.mkdir(path.dirname(output), {recursive: true});
    await fsp.copyFile(input, output);
  }
  return verifyDocumentation(destination);
}

module.exports = {documentationFiles, copyDocumentation, verifyDocumentation};
