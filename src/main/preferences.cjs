'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULTS = Object.freeze({theme: 'system', density: 'comfortable'});
function normalizePreferences(value = {}) {
  return {
    theme: ['system', 'light', 'dark'].includes(value?.theme) ? value.theme : DEFAULTS.theme,
    density: ['comfortable', 'compact'].includes(value?.density) ? value.density : DEFAULTS.density,
  };
}
function loadPreferences(file) {
  try {
    if (fs.statSync(file).size > 65536) return {...DEFAULTS};
    return normalizePreferences(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch { return {...DEFAULTS}; }
}
function savePreferences(file, value) {
  const settings = normalizePreferences(value);
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, {force: true}); }
  return settings;
}
module.exports = {DEFAULTS, normalizePreferences, loadPreferences, savePreferences};
