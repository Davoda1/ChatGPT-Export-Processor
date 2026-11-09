'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const yauzl = require('yauzl');
const CRC = require('crc-32');
const {readRecords} = require('./reader.cjs');
const {checkAbort, MAX_ENTRY, MAX_TOTAL, MAX_ENTRIES} = require('./inputs.cjs');

function referenceNames(reference) {
  const candidates = new Set([reference]);
  if (reference.startsWith('file-service://')) candidates.add(reference.slice(15));
  if (reference.startsWith('sediment://')) {
    const value = reference.slice(11); candidates.add(value);
    for (const part of value.split('#')) if (part) candidates.add(part);
  }
  for (const match of reference.matchAll(/\bfile[-_][A-Za-z0-9_.-]+\b/g)) candidates.add(match[0]);
  const names = new Set();
  for (const value of candidates) {
    const name = value.normalize('NFKC').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '') || 'asset';
    if (name !== value) names.add(`${name}-${crypto.createHash('sha256').update(value).digest('hex').slice(0,12)}.dat`);
    names.add(name + '.dat');
  }
  return names;
}

function outputName(entry) {
  // Export folders may contain characters forbidden by Windows. A stable
  // portable name also prevents case collisions and reserved device names.
  const base = path.posix.basename(entry.fileName).normalize('NFKC').replace(/[^A-Za-z0-9_.-]+/g, '_');
  const stem = base.replace(/\.dat$/i, '').replace(/^[._-]+|[._-]+$/g, '').slice(0,100) || 'attachment';
  const prefix = crypto.createHash('sha256').update(entry.fileName).digest('hex').slice(0,24);
  return `assets/${prefix}-${stem}.dat`;
}

async function findAssets(jsonFile, entries, sourceRoot, {signal} = {}) {
  const root = sourceRoot && sourceRoot !== '.' ? sourceRoot + '/' : '';
  const candidates = new Map();
  for (const entry of entries) {
    checkAbort(signal);
    if (root && !entry.fileName.startsWith(root)) continue;
    const relative = entry.fileName.slice(root.length);
    if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..') || !/\.dat$/i.test(relative)) continue;
    const name = path.posix.basename(relative);
    if (!candidates.has(name)) candidates.set(name, []);
    candidates.get(name).push(entry);
  }
  const assets = Object.create(null), selected = new Map();
  if (!candidates.size) return {assets, files:[]};
  let mapBytes = 2, conversationOrdinal = 0;
  for await (const record of readRecords(jsonFile, {}, () => {}, {signal})) {
    for (const [nodeKey,node] of Object.entries(record.value.mapping || {})) {
      checkAbort(signal);
      const message = node?.message;
      if (!message || typeof message !== 'object') continue;
      // Message IDs are not necessarily unique across conversations or nodes.
      // The ordinal and mapping key identify exactly the displayed message.
      const assetKey = JSON.stringify([conversationOrdinal,nodeKey]);
      const references = new Set(), queue = [message.content];
      for (const attachment of Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : []) {
        if (typeof attachment?.id === 'string') references.add(attachment.id);
      }
      while (queue.length) {
        const value = queue.pop();
        if (!value || typeof value !== 'object') continue;
        if (typeof value.asset_pointer === 'string') references.add(value.asset_pointer);
        for (const child of Object.values(value)) if (child && typeof child === 'object') queue.push(child);
      }
      const links = new Set();
      for (const reference of references) for (const name of referenceNames(reference)) for (const entry of candidates.get(name) || []) {
        const target = outputName(entry);
        selected.set(entry.fileName, {entry, name:target});
        links.add(target);
      }
      if (links.size) {
        const list = [...links].sort();
        const encodedKey = JSON.stringify(assetKey).replace(/[<>&\u2028\u2029]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4,'0'));
        mapBytes += Buffer.byteLength(encodedKey) + Buffer.byteLength(JSON.stringify(list)) + 2;
        // The independent HTML reader limits suffix metadata to 16 MiB.
        if (mapBytes > 8 * 1024 ** 2) throw new Error('Export attachment-link metadata exceeds the 8 MiB limit.');
        assets[assetKey] = list;
      }
    }
    conversationOrdinal++;
  }
  return {assets, files:[...selected.values()].sort((a,b) => a.name.localeCompare(b.name))};
}

async function copyAssets(archive, files, destination, {signal, progress = () => {}, extractedBytes = 0} = {}) {
  if (!files.length) return [];
  checkAbort(signal);
  const zip = await new Promise((resolve,reject) => yauzl.open(archive, {lazyEntries:true, autoClose:false, validateEntrySizes:true, strictFileNames:true}, (error,result) => error ? reject(error) : resolve(result)));
  const abort = () => zip.close();
  signal?.addEventListener('abort', abort, {once:true});
  try {
    const wanted = new Map(files.map(file => [file.entry.fileName,file]));
    const found = await new Promise((resolve,reject) => {
      let count = 0;
      const results = [], seen = new Set();
      const onAbort = () => {const error=new Error('Operation cancelled.');error.name='AbortError';reject(error);};
      signal?.addEventListener('abort', onAbort, {once:true});
      const finish = (error) => { signal?.removeEventListener('abort', onAbort); error ? reject(error) : resolve(results); };
      zip.once('error', finish); zip.once('end', () => finish());
      zip.on('entry', entry => {
        try {
          checkAbort(signal);
          if (++count > MAX_ENTRIES) throw new Error('ZIP entry-count limit exceeded.');
          const selected = wanted.get(entry.fileName);
          if (selected) {
            if (seen.has(entry.fileName)) throw new Error('Duplicate attachment ZIP entry.');
            seen.add(entry.fileName);
            const expected = selected.entry;
            for (const key of ['crc32','uncompressedSize','compressedSize','relativeOffsetOfLocalHeader','generalPurposeBitFlag','externalFileAttributes']) {
              if (entry[key] !== expected[key]) throw new Error('The input ZIP changed while attachments were being processed.');
            }
            results.push({...selected,entry});
          }
          zip.readEntry();
        } catch (error) { finish(error); zip.close(); }
      });
      zip.readEntry();
    });
    if (found.length !== files.length) throw new Error('The input ZIP changed while attachments were being processed.');
    let total = extractedBytes;
    for (const {entry} of found) {
      if (entry.generalPurposeBitFlag & 1) throw new Error('Encrypted attachment ZIP entries are unsupported.');
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > MAX_ENTRY || total + entry.uncompressedSize > MAX_TOTAL) throw new Error('Archive exceeds inspection size limits.');
      total += entry.uncompressedSize;
    }
    await fsp.mkdir(path.join(destination,'assets'), {mode:0o700});
    const copied = [];
    for (const {entry,name} of found) {
      checkAbort(signal);
      const target = path.join(destination, ...name.split('/'));
      const stream = await new Promise((resolve,reject) => zip.openReadStream(entry, (error,result) => error ? reject(error) : resolve(result)));
      let crc = 0, bytes = 0;
      const check = new Transform({transform(chunk,encoding,done) {
        bytes += chunk.length;
        if (bytes > MAX_ENTRY || bytes > entry.uncompressedSize) return done(new Error('Archive attachment exceeded size limit.'));
        crc = CRC.buf(chunk,crc); done(null,chunk);
      }});
      progress({phase:'Copying exported attachments', detail:path.posix.basename(entry.fileName)});
      await pipeline(stream,check,fs.createWriteStream(target,{flags:'wx',mode:0o600}),{signal});
      if ((crc >>> 0) !== entry.crc32 || bytes !== entry.uncompressedSize) throw new Error('ZIP attachment CRC/size mismatch.');
      copied.push({name,file:target});
    }
    return copied;
  } finally {
    signal?.removeEventListener('abort', abort);
    zip.close();
  }
}

module.exports = {findAssets, copyAssets, referenceNames};
