'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROLES = Object.freeze(['original', 'indexJson', 'indexHtml', 'bundle']);
const EXTENSIONS = {original: ['.zip', '.json'], indexJson: ['.json'], indexHtml: ['.html', '.htm'], bundle: ['.zip']};
function validateRole(role) {
  if (!ROLES.includes(role)) throw new Error('Unknown input type.');
  return role;
}
async function selectedFile(file, role) {
  validateRole(role);
  const resolved = await fs.realpath(file);
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || !EXTENSIONS[role].includes(path.extname(resolved).toLowerCase())) {
    throw new Error('Choose a supported regular file.');
  }
  return {path: resolved, name: path.basename(resolved), token: crypto.randomUUID(), bytes: stat.size};
}
function publicSelection(selection) {
  return Object.fromEntries(Object.entries(selection).map(([role, value]) => [role, value ? {name: value.name, token: value.token, bytes: value.bytes} : null]));
}
function conversionOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid conversion options.');
  for (const key of Object.keys(options)) if (!['standard', 'document', 'chatMessage'].includes(key)) throw new Error('Unknown conversion option.');
  const result = {};
  for (const key of ['standard', 'document', 'chatMessage']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error('Conversion options must be true or false.');
    result[key] = options[key] !== false;
  }
  return result;
}
function jobSpec(request, selection) {
  if (!request || !['convert', 'inspect'].includes(request.mode)) throw new Error('Choose conversion or inspection.');
  if (request.mode === 'convert') {
    if (!selection.original || path.extname(selection.original.path).toLowerCase() !== '.zip') throw new Error('Conversion requires an original ChatGPT export ZIP.');
    if (!selection.outputDir) throw new Error('Choose an output folder.');
    return {mode: 'convert', input: selection.original.path, outputDir: selection.outputDir.path, options: conversionOptions(request.options)};
  }
  const profile = request.profile ?? 'auto';
  if (!['auto', 'all', 'email'].includes(profile)) throw new Error('Choose a supported inspection profile.');
  const spec = {mode: 'inspect', profile};
  if (selection.original) spec.original = selection.original.path;
  if (request.inspectionSource === 'bundle') {
    if (!selection.bundle) throw new Error('Choose a processed ZIP bundle.');
    spec.indexJson = selection.bundle.path;
  } else {
    if (selection.indexJson) spec.indexJson = selection.indexJson.path;
    if (selection.indexHtml) spec.indexHtml = selection.indexHtml.path;
    if (!spec.indexJson && !spec.indexHtml) throw new Error('Choose a converted JSON or HTML file.');
  }
  return spec;
}
async function writeReportExclusive(destination, content, protectedFiles = []) {
  const parent = await fs.realpath(path.dirname(destination));
  const target = path.join(parent, path.basename(destination));
  const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
  for (const file of protectedFiles) {
    const real = await fs.realpath(file).catch(() => path.resolve(file));
    if (normalized(real) === normalized(target)) throw new Error('A report cannot replace an input or a conversion output.');
  }
  // Exclusive creation also rejects symlinks and hard links to existing files.
  const handle = await fs.open(target, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('That file already exists. Choose a new report filename.');
    throw error;
  });
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
  catch (error) { await handle.close(); await fs.rm(target, {force: true}); throw error; }
  await handle.close();
  return path.basename(target);
}
module.exports = {ROLES, validateRole, selectedFile, publicSelection, conversionOptions, jobSpec, writeReportExclusive};
