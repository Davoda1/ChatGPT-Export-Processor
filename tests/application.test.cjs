'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {JobController} = require('../src/main/job-controller.cjs');
const {parseArgs, runCli} = require('../src/cli.cjs');
const {loadPreferences, savePreferences} = require('../src/main/preferences.cjs');
const {selectedFile, jobSpec} = require('../src/main/file-policy.cjs');
const {conversation, workspace} = require('./helpers/conversion.cjs');

test('desktop job converts, independently audits the selected archive, and persists private reports', async t => {
  const original = conversation('synthetic-job');
  const w = await workspace(t, [['conversations.json', JSON.stringify([original])]]);
  const before = await fs.readFile(w.input);
  const events = [], controller = new JobController(event => events.push(event));
  t.after(() => controller.dispose());
  await controller.start({mode: 'convert', input: w.input, outputDir: w.root});
  const event = await controller.done;
  assert.equal(event.type, 'complete', event.error);
  assert.equal(event.value.status, 'PASS', JSON.stringify(event.value.findings));
  assert.equal(event.outputAvailable, true);
  assert.ok(event.value.files.find(file => file.role === 'original').name.includes('export.zip'));
  const report = JSON.parse(await fs.readFile(path.join(controller.outputDir, 'validation-report.json'), 'utf8'));
  assert.equal(report.coverage.complete, true);
  assert.equal(report.counts.conversations, 1);
  assert.equal(JSON.stringify(report).includes(w.root), false);
  assert.deepEqual(await fs.readFile(w.input), before);
  const output = controller.outputDir;
  assert.equal(await controller.cancel(), false, 'completed work must keep its evidence worker');
  assert.equal(JSON.parse(await controller.request('report', {format: 'json'})).status, 'PASS');
  const temporary = [...controller.temporary];
  await controller.dispose();
  assert.ok((await fs.readdir(output)).includes('validation-report.html'));
  for (const directory of temporary) await assert.rejects(fs.stat(directory), {code: 'ENOENT'});
  assert.equal(events.filter(value => value.type === 'complete').length, 1);
});

test('read-only job identifies changed user content and provides inert evidence', async t => {
  const original = conversation('synthetic-change', 'Assistant', '<script>synthetic user literal</script>');
  const w = await workspace(t, [['conversations.json', JSON.stringify([original])]]);
  const changed = structuredClone(original); changed.mapping.user.message.content.parts[0] = 'Changed';
  const converted = path.join(w.root, 'conversations-index.json'); await fs.writeFile(converted, JSON.stringify([changed]));
  const controller = new JobController(); t.after(() => controller.dispose());
  await controller.start({mode: 'inspect', original: w.input, indexJson: converted, profile: 'all'});
  const event = await controller.done;
  assert.equal(event.type, 'complete', event.error);
  assert.equal(event.value.status, 'FAIL');
  assert.equal(controller.outputDir, null);
  const finding = event.value.findings.find(value => value.rule === 'USER_CONTENT');
  assert.ok(finding);
  const evidence = await controller.request('evidence', {id: finding.id});
  assert.match(evidence.source, /<script>/);
  assert.match(evidence.actual, /Changed/);
  assert.equal((await fs.readdir(w.root)).length, 2);
});

test('worker cancellation settles and removes owned partial outputs', async t => {
  const w = await workspace(t, [['conversations.json', JSON.stringify(Array.from({length: 200}, (_, i) => conversation(`synthetic-${i}`, 'Body '.repeat(1000))))]]);
  const controller = new JobController(); t.after(() => controller.dispose());
  await controller.start({mode: 'convert', input: w.input, outputDir: w.root});
  assert.equal(await controller.cancel(), true);
  assert.equal((await controller.done).type, 'cancelled');
  assert.equal(controller.running, false);
  assert.deepEqual(await fs.readdir(w.root), ['export.zip']);
});

test('worker failure cleans temporary folders before allowing another job', async t => {
  const w = await workspace(t, [['unrelated.txt', 'Synthetic unrelated data']]);
  const controller = new JobController(); t.after(() => controller.dispose());
  await controller.start({mode: 'convert', input: w.input, outputDir: w.root});
  assert.equal((await controller.done).type, 'error');
  assert.deepEqual(await fs.readdir(w.root), ['export.zip']);
  assert.equal(controller.worker, null);
});

test('CLI validates incompatible options and never accepts deployment settings', () => {
  for (const args of [
    ['convert', 'export.zip'], ['convert', 'export.json', '--output-dir', '.'],
    ['convert', 'export.zip', '--output-dir', '.', '--deploy'],
    ['convert', 'export.zip', '--output-dir', '.', '--report', 'report.json'],
    ['inspect', '--json', 'index.json', '--bundle', 'bundle.zip'],
    ['inspect', '--json', 'index.json', '--profile', 'unknown'],
    ['inspect', '--json', 'index.json', '--json', 'other.json'],
  ]) assert.throws(() => parseArgs(args), JSON.stringify(args));
  assert.equal(parseArgs(['convert', 'export.zip', '--output-dir', '.', '--no-standard']).spec.options.standard, false);
  assert.equal(parseArgs(['inspect', '--bundle', 'bundle.zip']).spec.indexJson, path.resolve('bundle.zip'));
});

test('CLI returns limited coverage and writes a report without altering inspected data', async t => {
  const w = await workspace(t, [['conversations.json', JSON.stringify([conversation()])]]);
  const converted = path.join(w.root, 'index.json'), report = path.join(w.root, 'report.json');
  const data = JSON.stringify([conversation()]); await fs.writeFile(converted, data);
  const messages = [], io = {out: value => messages.push(value), error: value => messages.push(value)};
  const args = ['inspect', '--json', converted, '--report', report, '--format', 'json'];
  assert.equal(await runCli(args, io), 4);
  assert.equal(JSON.parse(await fs.readFile(report, 'utf8')).status, 'LIMITED');
  const before = await fs.readFile(report);
  assert.equal(await runCli(args, io), 1, 'existing report must not be overwritten');
  assert.deepEqual(await fs.readFile(report), before);
  assert.equal(await fs.readFile(converted, 'utf8'), data);
});

test('preferences persist only appearance settings and recover from malformed data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-preferences-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const file = path.join(root, 'preferences.json');
  assert.deepEqual(loadPreferences(file), {theme: 'system', density: 'comfortable'});
  savePreferences(file, {theme: 'dark', density: 'compact', unrelatedSecret: 'synthetic-value', lastInput: 'synthetic-input.zip'});
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {theme: 'dark', density: 'compact'});
  await fs.writeFile(file, '{broken');
  assert.deepEqual(loadPreferences(file), {theme: 'system', density: 'comfortable'});
  assert.deepEqual(await fs.readdir(root), ['preferences.json']);
});

test('selection capabilities enforce file types and isolate the selected inspection mode', async t => {
  const w = await workspace(t, [['conversations.json', JSON.stringify([conversation()])]]);
  const selection = {original: await selectedFile(w.input, 'original'), bundle: await selectedFile(w.input, 'bundle'), indexJson: {path: 'stale.json'}, indexHtml: {path: 'stale.html'}};
  await assert.rejects(selectedFile(w.input, 'indexHtml'));
  await assert.rejects(selectedFile(w.input, '__proto__'));
  const spec = jobSpec({mode: 'inspect', inspectionSource: 'bundle'}, selection);
  assert.equal(spec.indexJson, selection.bundle.path);
  assert.equal(spec.indexHtml, undefined);
});
