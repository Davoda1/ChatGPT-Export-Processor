'use strict';

const path = require('node:path');

const entryName = entry => entry.fileName ?? entry.entry;
const directory = name => path.posix.dirname(name);
const basename = name => path.posix.basename(name).toLowerCase();
const isOriginal = name => /^conversations(?:-\d+)?\.json$/.test(basename(name));

// Select one export before extracting it. The modern index is a filename
// marker only: its HTML and JavaScript are never parsed or executed.
function selectExportSource(entries) {
  const originals = entries.filter(entry => isOriginal(entryName(entry)));
  if (!originals.length) return null;
  const chats = entries.filter(entry => basename(entryName(entry)) === 'chat.html');
  if (chats.length > 1) throw new Error('The ZIP contains multiple original chat.html files.');
  let marker = chats[0] || null;
  if (!marker) {
    let indexes = entries.filter(entry => basename(entryName(entry)) === 'index.html');
    const siblings = indexes.filter(index => originals.some(entry => directory(entryName(entry)) === directory(entryName(index))));
    if (siblings.length) indexes = siblings;
    if (indexes.length > 1) throw new Error('The ZIP contains multiple export index.html files.');
    marker = indexes[0] || null;
  }
  let selected = marker ? originals.filter(entry => directory(entryName(entry)) === directory(entryName(marker))) : [];
  if (!selected.length) {
    const roots = new Set(originals.map(entry => directory(entryName(entry))));
    if (roots.size !== 1) throw new Error('Conversation JSON files in multiple directories make the export source ambiguous.');
    selected = originals;
  }
  const root = directory(entryName(selected[0]));
  return { originals: selected, chat: chats[0] || null, marker, root, assetRoot: marker ? directory(entryName(marker)) : root };
}

module.exports = { selectExportSource };
