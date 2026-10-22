'use strict';

// Optional, bounded synthetic integration regression; no private exports needed.
// Run: node scripts/test-large.cjs --mib 192
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { JobController } = require('../src/main/job-controller.cjs');
const { writeStoredZip, fileDigest } = require('../src/core/pipeline.cjs');
const { readRecords } = require('../src/core/reader.cjs');

function argumentsOf(args) {
  if (!args.length) return 64;
  if (args.length !== 2 || args[0] !== '--mib') throw new Error('Usage: node scripts/test-large.cjs [--mib 1..256]');
  const value = Number(args[1]);
  if (!Number.isInteger(value) || value < 1 || value > 256) throw new Error('--mib must be an integer from 1 to 256.');
  return value;
}

function syntheticConversation(ordinal, userText, assistantText) {
  return {
    id: `synthetic-large-${ordinal}`, title: `Synthetic conversation ${ordinal}`, current_node: 'assistant',
    mapping: {
      root: { id: 'root', parent: null, children: ['user'], message: null },
      user: { id: 'user', parent: 'root', children: ['assistant'], message: {
        id: `synthetic-user-${ordinal}`, author: { role: 'user' }, content: { content_type: 'text', parts: [userText] }, metadata: {}
      } },
      assistant: { id: 'assistant', parent: 'user', children: [], message: {
        id: `synthetic-assistant-${ordinal}`, author: { role: 'assistant' }, content: { content_type: 'text', parts: [assistantText] }, metadata: {}
      } }
    }
  };
}

async function generateFixture(file, targetMiB) {
  const userText = ('Synthetic user text. Unicode 日本語 😀. '.repeat(4500));
  const assistantText = ':::writing{variant="document" title="Synthetic document"}\n' +
    'Synthetic assistant text with **Markdown** and preserved numbers 0, -1.25, 2.5.\n'.repeat(2000) + '\n:::';
  const userHash = crypto.createHash('sha256');
  const output = await fs.open(file, 'wx', 0o600);
  let count = 0, bytes = 2;
  try {
    await output.write('[\n');
    while (bytes < targetMiB * 1024 ** 2) {
      const record = syntheticConversation(count, userText + ` Record ${count}.`, assistantText);
      userHash.update(record.id + '\0' + JSON.stringify(record.mapping.user.message.content) + '\n');
      const serialized = (count ? ',\n' : '') + JSON.stringify(record);
      await output.write(serialized);
      bytes += Buffer.byteLength(serialized);
      count++;
    }
    await output.write('\n]\n');
    await output.sync();
  } finally { await output.close(); }
  return { conversations: count, bytes: bytes + 3, userContentSha256: userHash.digest('hex') };
}

async function main() {
  const targetMiB = argumentsOf(process.argv.slice(2));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-large-test-'));
  let controller, monitor, deadline;
  const started = performance.now();
  let peakRss = process.memoryUsage().rss;
  let lastPhase = '';
  try {
    const original = path.join(temporary, 'conversations.json');
    const fixture = await generateFixture(original, targetMiB);
    const input = path.join(temporary, 'synthetic-export.zip');
    await writeStoredZip([{ name: 'conversations.json', file: original }], input);
    const originalHash = await fileDigest(original), archiveHash = await fileDigest(input);
    const jobStarted = performance.now();
    controller = new JobController(event => {
      if (event.type === 'progress' && event.value.phase !== lastPhase) {
        lastPhase = event.value.phase;
        process.stderr.write(`${lastPhase}\n`);
      }
    });
    monitor = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 200);
    await controller.start({ mode: 'convert', input, outputDir: temporary, options: { standard: true, document: true, chatMessage: true } });
    const outcome = await Promise.race([
      controller.done,
      new Promise((resolve, reject) => { deadline = setTimeout(() => reject(new Error('Large regression exceeded the 10-minute bound.')), 10 * 60 * 1000); })
    ]);
    clearTimeout(deadline);
    const jobElapsedMs = performance.now() - jobStarted;
    assert.equal(outcome.type, 'complete', outcome.error || 'Job did not complete');
    const report = outcome.value;
    assert.equal(report.status, 'PASS', JSON.stringify({ status: report.status, findings: report.findings?.slice(0, 3) }));
    assert.equal(report.counts.conversations, fixture.conversations);
    assert.equal(report.counts.userMessages, fixture.conversations);
    assert.equal(report.coverage.complete, true);
    const output = controller.outputDir;
    assert.equal(await fileDigest(original), originalHash, 'Synthetic source JSON changed');
    assert.equal(await fileDigest(input), archiveHash, 'Selected source ZIP changed');
    assert.equal(await fileDigest(path.join(output, 'conversations.json')), originalHash, 'Merged original changed content');
    const outputUsers = crypto.createHash('sha256');
    const convertedRecords = crypto.createHash('sha256');
    let jsonCount = 0, htmlCount = 0;
    for await (const { value } of readRecords(path.join(output, 'conversations-index.json'))) {
      outputUsers.update(value.id + '\0' + JSON.stringify(value.mapping.user.message.content) + '\n');
      convertedRecords.update(JSON.stringify(value) + '\n');
      assert.ok(value.mapping.assistant.message.content.parts[0].startsWith('**TITLE**: Synthetic document'));
      jsonCount++;
    }
    const htmlRecords = crypto.createHash('sha256');
    for await (const { value } of readRecords(path.join(output, 'chat-index.html'))) {
      htmlRecords.update(JSON.stringify(value) + '\n'); htmlCount++;
    }
    assert.equal(outputUsers.digest('hex'), fixture.userContentSha256);
    assert.equal(convertedRecords.digest('hex'), htmlRecords.digest('hex'));
    assert.equal(jsonCount, fixture.conversations); assert.equal(htmlCount, fixture.conversations);
    const outputFiles = {};
    for (const name of await fs.readdir(output)) outputFiles[name] = (await fs.stat(path.join(output, name))).size;
    peakRss = Math.max(peakRss, process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
    console.log(JSON.stringify({
      status: 'PASS', requestedMiB: targetMiB, inputJsonBytes: fixture.bytes,
      inputArchiveBytes: (await fs.stat(input)).size, inputConversations: fixture.conversations,
      outputJsonConversations: jsonCount, outputHtmlConversations: htmlCount,
      validationStatus: report.status, validationCounts: report.counts, coverageComplete: report.coverage.complete,
      userContentPreserved: true, originalJsonUnchanged: true, originalArchiveUnchanged: true,
      jobElapsedSeconds: Number((jobElapsedMs / 1000).toFixed(3)),
      totalElapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
      peakRssMiB: Number((peakRss / 1024 ** 2).toFixed(1)), outputFiles
    }, null, 2));
  } finally {
    clearInterval(monitor); clearTimeout(deadline);
    await controller?.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
