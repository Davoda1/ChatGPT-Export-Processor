'use strict';
const {parentPort} = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const {audit, evidence} = require('../core/audit.cjs');
const {publicReport, toHtml, toCsv} = require('../core/report.cjs');
let result = null, abort = null;
function send(type, value) { parentPort.postMessage({type, value}); }
function progress(value) { send('progress', value); }

parentPort.on('message', async message => {
  try {
    if (message.action === 'start') {
      if (abort) throw new Error('A task is already running.');
      abort = new AbortController();
      const {signal} = abort;
      let spec = message.spec, conversion;
      if (spec.mode === 'convert') {
        const {processExport} = require('../core/pipeline.cjs');
        conversion = await processExport(spec, {signal, progress});
        send('owned-output', conversion.outputDir);
        // Validate against the selected archive, independently of the converter's
        // merged copy, so converter omissions cannot become their own baseline.
        spec = {original: message.spec.input, indexJson: conversion.paths.indexJson, indexHtml: conversion.paths.indexHtml, profile: conversion.profile ?? message.spec.options};
      }
      signal.throwIfAborted();
      result = await audit(spec, {keepInputs: true, progress, signal});
      signal.throwIfAborted();
      if (conversion) {
        const clean = publicReport(result.report);
        await fs.writeFile(path.join(conversion.outputDir, 'validation-report.json'), JSON.stringify(clean, null, 2) + '\n', {flag: 'wx', mode: 0o600});
        await fs.writeFile(path.join(conversion.outputDir, 'validation-report.html'), toHtml(clean), {flag: 'wx', mode: 0o600});
      }
      signal.throwIfAborted();
      send('complete', {
        report: publicReport(result.report),
        outputDir: conversion?.outputDir ?? null,
        protectedFiles: [...(result.inputs?.protectedFiles ?? []), ...Object.values(conversion?.paths ?? {}).filter(value => typeof value === 'string')],
      });
      abort = null;
    } else if (message.action === 'cancel') {
      abort?.abort(new Error('Cancelled'));
    } else if (message.action === 'evidence') {
      if (!result) throw new Error('Complete an inspection first.');
      const value = await evidence(result, message.id);
      parentPort.postMessage({type: 'reply', requestId: message.requestId, value});
    } else if (message.action === 'report') {
      if (!result) throw new Error('Complete an inspection first.');
      const clean = publicReport(result.report, false);
      const content = message.format === 'html' ? toHtml(clean) : message.format === 'csv' ? toCsv(clean) : JSON.stringify(clean, null, 2) + '\n';
      parentPort.postMessage({type: 'reply', requestId: message.requestId, value: content});
    } else if (message.action === 'cleanup') {
      await result?.inputs?.cleanup();
      parentPort.postMessage({type: 'reply', requestId: message.requestId, value: true});
    }
  } catch (error) {
    if (message.requestId) parentPort.postMessage({type: 'reply', requestId: message.requestId, error: error.message});
    else {
      const cancelled = abort?.signal.aborted;
      abort = null;
      send(cancelled ? 'cancelled' : 'error', cancelled ? null : error.message);
    }
  }
});
