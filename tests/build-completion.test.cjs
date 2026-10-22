'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {Readable} = require('node:stream');
const asar = require('@electron/asar');
const disk = require('@electron/asar/lib/disk');
const {AsarPackager} = require('app-builder-lib/out/asar/asarUtil');
const {withAsarWriteCompletion} = require('../scripts/build.cjs');

test('the production builder waits for complete ASAR bytes and restores its writer', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-build-test-'));
  t.after(() => fs.rm(temporary, {recursive: true, force: true, maxRetries: 5}));
  const archive = path.join(temporary, 'app.asar');
  const members = [
    {name: 'payload.bin', content: Buffer.alloc(128 * 1024, 0x61)},
    {name: 'package.json', content: Buffer.from(JSON.stringify({name: 'chatgpt-export-processor', version: '1.0.0', author: 'davoda1'}))},
  ];
  const streams = members.map(({name, content}) => ({
    path: name, type: 'file', stat: {size: content.length, mode: 0o100644},
    streamGenerator: () => Readable.from([content]),
  }));
  const original = disk.streamFilesystem;
  let output;
  const observedWriter = async (...args) => {output = await original(...args); return output;};
  disk.streamFilesystem = observedWriter;
  try {
    // Exercise the builder's real dynamic import of the pinned ASAR package.
    await withAsarWriteCompletion(() => AsarPackager.prototype.executeElectronAsar.call({outFile: archive}, streams));
    assert.equal(disk.streamFilesystem, observedWriter);
    assert.equal(output.writableFinished, true);
    assert.equal(output.closed, true);
    for (const member of members) assert.deepEqual(asar.extractFile(archive, member.name), member.content);
    const header = asar.getRawHeader(archive);
    const payloadSize = members.reduce((total, member) => total + member.content.length, 0);
    assert.equal((await fs.stat(archive)).size, 8 + header.headerSize + payloadSize);
  } finally {disk.streamFilesystem = original;}
});

test('the ASAR completion wrapper restores its writer and preserves build failures', async () => {
  const original = disk.streamFilesystem;
  const failure = new Error('Synthetic build failure');
  await assert.rejects(withAsarWriteCompletion(async () => {
    assert.notEqual(disk.streamFilesystem, original);
    throw failure;
  }), error => error === failure);
  assert.equal(disk.streamFilesystem, original);
});
