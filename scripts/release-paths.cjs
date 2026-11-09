'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Release tools operate on this checkout's build files. Resolve both lexical
// traversal and existing symbolic links before reading or creating anything.
function withinCheckout(root, value, {mustExist = true} = {}) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) throw new Error('A release path is required.');
  const base = fs.realpathSync(root);
  const candidate = path.resolve(base, value);
  if (!candidate.startsWith(base + path.sep)) throw new Error('Release paths must remain inside the checkout.');
  let existing = candidate;
  if (!mustExist) {
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
  }
  const real = fs.realpathSync(existing);
  if (real !== base && !real.startsWith(base + path.sep)) throw new Error('Release paths must not follow links outside the checkout.');
  const resolved = path.resolve(real, path.relative(existing, candidate));
  if (!resolved.startsWith(base + path.sep)) throw new Error('Release paths must remain inside the checkout.');
  return resolved;
}

module.exports = {withinCheckout};
