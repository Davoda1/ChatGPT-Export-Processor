'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {writeReportExclusive, jobSpec} = require('../src/main/file-policy.cjs');
const {JobController} = require('../src/main/job-controller.cjs');
const {readRecords} = require('../src/core/reader.cjs');
const {transformObj, enabledSet} = require('../src/core/converter.cjs');

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-independent-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}

test('report writing refuses existing input, hardlink and symlink aliases without changing bytes', async t => {
  const root = await directory(t);
  const source = path.join(root, 'conversations.json');
  const original = '[{"id":"synthetic","mapping":{}}]\n';
  await fs.writeFile(source, original);
  const hardlink = path.join(root, 'hardlink.json');
  await fs.link(source, hardlink);
  for (const target of [source, hardlink]) {
    await assert.rejects(writeReportExclusive(target, 'replacement', [source]));
    assert.equal(await fs.readFile(source, 'utf8'), original);
  }
  const symlink = path.join(root, 'symlink.json');
  try { await fs.symlink(source, symlink); }
  catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    t.diagnostic('This environment does not permit creating a symbolic link.');
    return;
  }
  await assert.rejects(writeReportExclusive(symlink, 'replacement', [source]));
  assert.equal(await fs.readFile(source, 'utf8'), original);
});

test('failed report writes remove their own new file and preserve unrelated files', async t => {
  const root = await directory(t);
  const unrelated = path.join(root, 'keep.txt');
  const report = path.join(root, 'report.json');
  await fs.writeFile(unrelated, 'Keep this file');
  await assert.rejects(writeReportExclusive(report, Symbol('invalid report body'), []));
  await assert.rejects(fs.stat(report), {code: 'ENOENT'});
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'Keep this file');
});

test('renderer requests cannot redirect a job to a path outside selected file capabilities', () => {
  const selection = {
    original: {path: path.resolve('selected-export.zip')},
    outputDir: {path: path.resolve('chosen-output')},
  };
  const spec = jobSpec({mode: 'convert', input: path.resolve('unselected.zip'), outputDir: path.resolve('unselected-output')}, selection);
  assert.equal(spec.input, selection.original.path);
  assert.equal(spec.outputDir, selection.outputDir.path);
  assert.throws(() => jobSpec({mode: 'convert', options: {deploy: true}}, selection));
});

test('concurrent start calls reserve exactly one worker job', async t => {
  const controller = new JobController();
  t.after(() => controller.dispose());
  const attempts = await Promise.allSettled([
    controller.start({mode: 'inspect'}),
    controller.start({mode: 'inspect'}),
  ]);
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(x => x.status === 'rejected').length, 1);
  await controller.done;
});

test('failed conversion cleans only its created run directory', async t => {
  const root = await directory(t);
  const invalid = path.join(root, 'invalid.zip');
  const output = path.join(root, 'outputs');
  await fs.mkdir(output);
  await fs.writeFile(invalid, 'This is not a ZIP archive');
  await fs.writeFile(path.join(output, 'keep.txt'), 'Unrelated');
  const controller = new JobController();
  t.after(() => controller.dispose());
  await controller.start({mode: 'convert', input: invalid, outputDir: output});
  const result = await controller.done;
  assert.equal(result.type, 'error');
  await controller.dispose();
  assert.deepEqual(await fs.readdir(output), ['keep.txt']);
  assert.equal(await fs.readFile(invalid, 'utf8'), 'This is not a ZIP archive');
});

test('prototype-like JSON keys remain own data and never alter runtime prototypes', async t => {
  const root = await directory(t);
  const file = path.join(root, 'prototype-keys.json');
  const raw = '[{"id":"synthetic","mapping":{"__proto__":{"parent":null,"children":[],"message":{"author":{"role":"user"},"content":{"parts":["Untouched"],"__proto__":{"processorPolluted":true}},"metadata":{}}}}}]';
  await fs.writeFile(file, raw);
  const records = [];
  for await (const record of readRecords(file)) records.push(record.value);
  const source = records[0];
  const converted = structuredClone(source);
  transformObj(converted, enabledSet({allWritingBlocks: true}));
  assert.deepEqual(converted, source);
  assert.equal(Object.hasOwn(converted.mapping, '__proto__'), true);
  assert.equal(Object.hasOwn(converted.mapping.__proto__.message.content, '__proto__'), true);
  assert.equal(Object.prototype.processorPolluted, undefined);
});
