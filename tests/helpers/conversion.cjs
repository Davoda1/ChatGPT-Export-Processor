'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const CRC = require('crc-32');

const marker = (name, value) => `\ue200${name}\ue202${typeof value === 'string' ? value : JSON.stringify(value)}\ue201`;
function conversation(id = 'synthetic-1', assistant = 'Synthetic assistant text.', user = 'Synthetic user text.') {
  return {
    id, title: 'Synthetic test conversation', current_node: 'assistant',
    mapping: {
      root: { id: 'root', parent: null, children: ['user'], message: null },
      user: { id: 'user', parent: 'root', children: ['assistant'], message: {
        id: 'user-message', author: { role: 'user' }, content: { content_type: 'text', parts: [user] }, metadata: {}
      }},
      assistant: { id: 'assistant', parent: 'user', children: [], message: {
        id: 'assistant-message', author: { role: 'assistant' }, content: { content_type: 'text', parts: [assistant] }, metadata: {}
      }}
    }
  };
}

// A deliberately small fixture writer. Production bundling is tested separately.
function fixtureZip(entries, { deflate = false, corruptCrc = false } = {}) {
  const locals = [], directory = [];
  let offset = 0;
  for (const [filename, content] of entries) {
    const name = Buffer.from(filename), bytes = Buffer.from(content);
    const packed = deflate ? zlib.deflateRawSync(bytes) : bytes;
    const crc = ((CRC.buf(bytes) >>> 0) ^ (corruptCrc ? 1 : 0)) >>> 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(deflate ? 8 : 0, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42); name.copy(central, 46);
    locals.push(local, packed); directory.push(central); offset += local.length + packed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.reduce((sum, item) => sum + item.length, 0), 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}

async function workspace(t, entries, options) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'export.zip');
  await fs.writeFile(input, fixtureZip(entries, options));
  return { root, input };
}

module.exports = { marker, conversation, fixtureZip, workspace };
