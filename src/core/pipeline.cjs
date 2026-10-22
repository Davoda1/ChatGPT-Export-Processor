'use strict';

// Copyright (c) 2026 davoda1. MIT license.
// File processing is streamed. Only one conversation is transformed at a time.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const CRC = require('crc-32');
const { readRecords } = require('./reader.cjs');
const { unpackZip } = require('./inputs.cjs');
const converter = require('./converter.cjs');

function checkAbort(signal) {
  if (signal?.aborted) {
    const error = new Error('Operation cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

async function writeAll(handle, value, signal) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) {
    checkAbort(signal);
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw new Error('Unable to write the output file.');
    offset += bytesWritten;
  }
}

function selectOriginals(descriptors) {
  const originals = descriptors.filter(item => item.role === 'original');
  if (!originals.length) throw new Error('The ZIP has no original conversations JSON files.');
  const singles = originals.filter(item => /^conversations\.json$/i.test(path.posix.basename(item.entry)));
  const chunks = originals.filter(item => /^conversations-\d+\.json$/i.test(path.posix.basename(item.entry)));
  if (singles.length && chunks.length) {
    throw new Error('The ZIP contains both conversations.json and split conversation files. Choose an unambiguous export.');
  }
  if (singles.length === 1) return singles;
  if (singles.length > 1) throw new Error('The ZIP contains multiple conversations.json files.');
  chunks.sort((a, b) => Number(/-(\d+)\.json$/i.exec(a.entry)[1]) - Number(/-(\d+)\.json$/i.exec(b.entry)[1]));
  const numbers = chunks.map(item => Number(/-(\d+)\.json$/i.exec(item.entry)[1]));
  if (!numbers.length || !numbers.every(Number.isSafeInteger) || numbers[0] > 1 ||
      numbers.some((n, index) => index && n !== numbers[index - 1] + 1)) {
    throw new Error('Conversation chunk numbers are missing, duplicated, or unsupported.');
  }
  return chunks;
}

function checkedConversation(record) {
  if (record.duplicates.length) throw new Error('Duplicate JSON object keys prevent lossless conversion.');
  const c = record.value;
  if (!c || typeof c !== 'object' || Array.isArray(c) || !c.mapping ||
      typeof c.mapping !== 'object' || Array.isArray(c.mapping)) {
    throw new Error('Expected a ChatGPT conversation with a mapping object.');
  }
  return c;
}

function transformChecked(original, enabled) {
  const converted = structuredClone(original);
  converter.transformObj(converted, enabled);
  const [, difference] = converter.checkUserContentUnchanged(original, converted);
  if (difference) throw new Error('User content preservation check failed.');
  return converted;
}

async function writeConversations(sources, paths, enabled, progress, signal) {
  const original = await fsp.open(paths.original, 'wx', 0o600);
  let index;
  let count = 0;
  try {
    index = await fsp.open(paths.indexJson, 'wx', 0o600);
    await writeAll(original, '[\n', signal);
    await writeAll(index, '[\n', signal);
    for (const source of sources) {
      checkAbort(signal);
      for await (const record of readRecords(source.file, {}, () => {}, { signal })) {
        checkAbort(signal);
        const before = checkedConversation(record);
        const after = transformChecked(before, enabled);
        const separator = count ? ',\n' : '';
        await writeAll(original, separator + JSON.stringify(before), signal);
        await writeAll(index, separator + JSON.stringify(after), signal);
        count++;
        if (count % 25 === 0) progress({ phase: 'Converting JSON', detail: `${count} conversations`, conversations: count });
      }
    }
    await writeAll(original, '\n]\n', signal);
    await writeAll(index, '\n]\n', signal);
    await Promise.all([original.sync(), index.sync()]);
    return count;
  } finally {
    await Promise.allSettled([original.close(), index?.close()]);
  }
}

async function writeHtml(source, target, progress, signal) {
  const { prefix, suffix } = require('../viewer/shell.cjs').getShell();
  const output = await fsp.open(target, 'wx', 0o600);
  let count = 0;
  try {
    await writeAll(output, prefix + '[\n', signal);
    for await (const record of readRecords(source, {}, () => {}, { signal })) {
      checkAbort(signal);
      const value = checkedConversation(record);
      await writeAll(output, (count ? ',\n' : '') + converter.htmlSafeJson(value), signal);
      count++;
      if (count % 25 === 0) progress({ phase: 'Creating HTML viewer', detail: `${count} conversations`, conversations: count });
    }
    await writeAll(output, '\n]' + suffix, signal);
    await output.sync();
    return count;
  } finally {
    await output.close();
  }
}

async function copyExclusive(source, destination, signal) {
  const check = new Transform({ transform(chunk, encoding, done) {
    try { checkAbort(signal); done(null, chunk); } catch (error) { done(error); }
  }});
  await pipeline(fs.createReadStream(source), check, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
}

async function fileDigest(file, signal) {
  const sha = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) {
    checkAbort(signal);
    sha.update(bytes);
  }
  return sha.digest('hex');
}

function zipDate() {
  const now = new Date();
  const year = Math.max(1980, Math.min(2107, now.getFullYear()));
  return { date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1) };
}

// Stored ZIP avoids compressing all output in memory. ZIP64 fields are emitted
// when sizes or offsets require them, including on the larger test path.
async function writeStoredZip(files, destination, { signal, progress = () => {}, forceZip64 = false } = {}) {
  const output = await fsp.open(destination, 'wx', 0o600);
  const central = [];
  const stamp = zipDate();
  let offset = 0;
  try {
    for (const file of files) {
      checkAbort(signal);
      const name = Buffer.from(file.name);
      if (!file.name || file.name !== path.posix.basename(file.name) || /[\\\x00-\x1f]/.test(file.name) || name.length > 65535) {
        throw new Error('Unsafe output ZIP filename.');
      }
      let crc = 0;
      let size = 0;
      for await (const bytes of fs.createReadStream(file.file)) {
        checkAbort(signal);
        crc = CRC.buf(bytes, crc);
        size += bytes.length;
      }
      const size64 = forceZip64 || size >= 0xffffffff;
      const offset64 = forceZip64 || offset >= 0xffffffff;
      const entry64 = size64 || offset64;
      const localExtra = Buffer.alloc(size64 ? 20 : 0);
      if (size64) {
        localExtra.writeUInt16LE(1, 0); localExtra.writeUInt16LE(16, 2);
        localExtra.writeBigUInt64LE(BigInt(size), 4); localExtra.writeBigUInt64LE(BigInt(size), 12);
      }
      const local = Buffer.alloc(30 + name.length + localExtra.length);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(entry64 ? 45 : 20, 4);
      local.writeUInt16LE(0x800, 6); local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12);
      local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(size64 ? 0xffffffff : size, 18);
      local.writeUInt32LE(size64 ? 0xffffffff : size, 22);
      local.writeUInt16LE(name.length, 26); local.writeUInt16LE(localExtra.length, 28);
      name.copy(local, 30); localExtra.copy(local, 30 + name.length);
      await writeAll(output, local, signal);
      let written = 0;
      let writtenCrc = 0;
      for await (const bytes of fs.createReadStream(file.file)) {
        written += bytes.length;
        writtenCrc = CRC.buf(bytes, writtenCrc);
        await writeAll(output, bytes, signal);
      }
      if (written !== size || writtenCrc !== crc) throw new Error('An output changed while the bundle was being created.');
      const extra = Buffer.alloc(entry64 ? 4 + (size64 ? 16 : 0) + (offset64 ? 8 : 0) : 0);
      if (entry64) {
        extra.writeUInt16LE(1, 0); extra.writeUInt16LE(extra.length - 4, 2);
        let pos = 4;
        if (size64) { extra.writeBigUInt64LE(BigInt(size), pos); extra.writeBigUInt64LE(BigInt(size), pos + 8); pos += 16; }
        if (offset64) extra.writeBigUInt64LE(BigInt(offset), pos);
      }
      const header = Buffer.alloc(46 + name.length + extra.length);
      header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(0x300 | (entry64 ? 45 : 20), 4);
      header.writeUInt16LE(entry64 ? 45 : 20, 6); header.writeUInt16LE(0x800, 8);
      header.writeUInt16LE(stamp.time, 12); header.writeUInt16LE(stamp.date, 14);
      header.writeUInt32LE(crc >>> 0, 16); header.writeUInt32LE(size64 ? 0xffffffff : size, 20);
      header.writeUInt32LE(size64 ? 0xffffffff : size, 24); header.writeUInt16LE(name.length, 28);
      header.writeUInt16LE(extra.length, 30); header.writeUInt32LE((0o100600 << 16) >>> 0, 38);
      header.writeUInt32LE(offset64 ? 0xffffffff : offset, 42);
      name.copy(header, 46); extra.copy(header, 46 + name.length); central.push(header);
      offset += local.length + size;
      progress({ phase: 'Packaging outputs', detail: file.name });
    }
    const centralOffset = offset;
    const centralSize = central.reduce((sum, item) => sum + item.length, 0);
    for (const item of central) await writeAll(output, item, signal);
    const zip64 = forceZip64 || centralOffset >= 0xffffffff || centralSize >= 0xffffffff ||
      central.length >= 0xffff || central.some(item => item.readUInt16LE(6) >= 45);
    if (zip64) {
      const end64 = Buffer.alloc(56);
      end64.writeUInt32LE(0x06064b50, 0); end64.writeBigUInt64LE(44n, 4);
      end64.writeUInt16LE(45, 12); end64.writeUInt16LE(45, 14);
      end64.writeBigUInt64LE(BigInt(central.length), 24); end64.writeBigUInt64LE(BigInt(central.length), 32);
      end64.writeBigUInt64LE(BigInt(centralSize), 40); end64.writeBigUInt64LE(BigInt(centralOffset), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(centralOffset + centralSize), 8);
      locator.writeUInt32LE(1, 16);
      await writeAll(output, end64, signal); await writeAll(output, locator, signal);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(zip64 ? 0xffff : central.length, 8);
    end.writeUInt16LE(zip64 ? 0xffff : central.length, 10);
    end.writeUInt32LE(zip64 ? 0xffffffff : centralSize, 12); end.writeUInt32LE(zip64 ? 0xffffffff : centralOffset, 16);
    await writeAll(output, end, signal); await output.sync();
  } finally {
    await output.close();
  }
}

async function processExport(spec, { progress = () => {}, signal } = {}) {
  checkAbort(signal);
  if (!spec || typeof spec.input !== 'string' || typeof spec.outputDir !== 'string') throw new Error('Select an export ZIP and an output folder.');
  const input = await fsp.realpath(spec.input);
  if (!/\.zip$/i.test(input) || !(await fsp.stat(input)).isFile()) throw new Error('Select a ChatGPT export ZIP file.');
  const parent = await fsp.realpath(spec.outputDir);
  if (!(await fsp.stat(parent)).isDirectory()) throw new Error('The output location must be an existing directory.');
  const options = spec.options || {};
  for (const key of ['standard', 'document', 'chatMessage']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error('Writing block options must be true or false.');
  }
  const selected = { standard: options.standard !== false, document: options.document !== false, chatMessage: options.chatMessage !== false };
  const profile = (selected.standard ? 1 : 0) | (selected.document ? 2 : 0) | (selected.chatMessage ? 4 : 0);
  const enabled = converter.enabledSet(selected);
  const outputDir = await fsp.mkdtemp(path.join(parent, 'chatgpt-export-'));
  await fsp.chmod(outputDir, 0o700);
  const staging = path.join(outputDir, '.work');
  try {
    // The worker owner records this exclusively created folder for crash/cancel cleanup.
    progress({ temporary: outputDir });
    checkAbort(signal);
    await fsp.mkdir(staging, { mode: 0o700 });
    progress({ phase: 'Reading ZIP', detail: path.basename(input) });
    const inputs = await unpackZip(input, staging, progress, { signal });
    checkAbort(signal);
    const originals = selectOriginals(inputs);
    const htmlInputs = inputs.filter(item => item.role === 'originalHtml');
    if (htmlInputs.length > 1) throw new Error('The ZIP contains multiple original HTML files.');
    const paths = {
      original: path.join(outputDir, 'conversations.json'),
      indexJson: path.join(outputDir, 'conversations-index.json'),
      indexHtml: path.join(outputDir, 'chat-index.html'),
      bundle: path.join(outputDir, 'chatgpt-export-processed.zip'),
      checksums: path.join(outputDir, 'SHA256SUM.txt')
    };
    progress({ phase: 'Converting JSON', detail: `${originals.length} source file(s)` });
    const conversations = await writeConversations(originals, paths, enabled, progress, signal);
    if (htmlInputs.length) {
      paths.originalHtml = path.join(outputDir, 'chat.html');
      await copyExclusive(htmlInputs[0].file, paths.originalHtml, signal);
    }
    const htmlConversations = await writeHtml(paths.indexJson, paths.indexHtml, progress, signal);
    const files = ['original', 'indexJson', 'indexHtml', ...(paths.originalHtml ? ['originalHtml'] : [])]
      .map(key => ({ name: path.basename(paths[key]), file: paths[key] }));
    const sums = [];
    for (const file of files) {
      checkAbort(signal);
      progress({ phase: 'Checking output hashes', detail: file.name });
      sums.push(`${await fileDigest(file.file, signal)}  ${file.name}\n`);
    }
    await fsp.writeFile(paths.checksums, sums.join(''), { flag: 'wx', mode: 0o600 });
    files.push({ name: 'SHA256SUM.txt', file: paths.checksums });
    await writeStoredZip(files, paths.bundle, { progress, signal });
    await fsp.rm(staging, { recursive: true, force: true });
    checkAbort(signal);
    progress({ phase: 'Conversion complete', detail: `${conversations} conversations; independent validation follows`, conversations });
    return { paths, outputDir, conversations, htmlConversations, profile };
  } catch (error) {
    await fsp.rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { processExport, writeStoredZip, selectOriginals, fileDigest };
