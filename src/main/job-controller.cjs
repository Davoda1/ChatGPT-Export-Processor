'use strict';
const {Worker} = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

class JobController {
  constructor(onEvent = () => {}) {
    this.onEvent = onEvent;
    this.worker = null;
    this.running = false;
    this.result = null;
    this.outputDir = null;
    this.protectedFiles = [];
    this.temporary = new Set();
    this.pending = new Map();
    this.done = Promise.resolve(null);
    this.starting = false;
    this.settling = false;
    this.cancelling = false;
  }
  async start(spec) {
    if (this.running || this.starting || this.settling || this.cancelling) throw new Error('A task is already running.');
    this.starting = true;
    try { await this.dispose(); } catch (error) { this.starting = false; throw error; }
    this.running = true;
    this.result = null;
    this.outputDir = null;
    this.protectedFiles = [];
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    let worker;
    try { worker = this.worker = new Worker(path.join(__dirname, 'job-worker.cjs')); }
    catch (error) { this.running = false; this.starting = false; this.resolveDone({type: 'error', error: error.message}); throw error; }
    worker.on('message', message => this.handleMessage(worker, message));
    worker.on('error', error => this.workerFailed(worker, error.message));
    worker.on('exit', code => {
      if (worker === this.worker) this.workerFailed(worker, `Processing worker stopped unexpectedly (${code}).`);
    });
    worker.postMessage({action: 'start', spec});
    this.starting = false;
    return {started: true};
  }
  handleMessage(worker, message) {
    if (worker !== this.worker) return;
    if (message.type === 'reply') {
      const request = this.pending.get(message.requestId);
      if (request) { this.pending.delete(message.requestId); message.error ? request.reject(new Error(message.error)) : request.resolve(message.value); }
    } else if (message.type === 'progress') {
      if (message.value?.temporary) this.temporary.add(message.value.temporary);
      else if (this.running) this.onEvent(message);
    } else if (message.type === 'owned-output') {
      this.temporary.add(message.value);
    } else if (message.type === 'complete') {
      this.result = message.value.report;
      this.outputDir = message.value.outputDir;
      this.protectedFiles = message.value.protectedFiles;
      if (this.outputDir) this.temporary.delete(this.outputDir);
      this.finish(worker, 'complete', this.result);
    } else if (message.type === 'error' || message.type === 'cancelled') this.finish(worker, message.type, message.value);
  }
  workerFailed(worker, error) {
    if (worker !== this.worker) return;
    if (this.running) this.finish(worker, 'error', error);
    else {
      for (const request of this.pending.values()) request.reject(new Error(error));
      this.pending.clear();
      this.worker = null;
      this.onEvent({type: 'error', error});
    }
  }
  async finish(worker, type, value) {
    if (worker !== this.worker || !this.running) return;
    this.running = false;
    this.settling = true;
    const resolve = this.resolveDone;
    if (type !== 'complete') {
      try { await this.dispose(); }
      catch { type = 'error'; value = 'The task stopped, but a temporary folder could not be removed.'; }
      this.result = null; this.outputDir = null; this.protectedFiles = [];
    }
    const event = type === 'error' ? {type, error: value} : {type, value};
    if (type === 'complete') event.outputAvailable = !!this.outputDir;
    this.settling = false;
    this.onEvent(event);
    resolve?.(event);
  }
  request(action, values = {}) {
    if (!this.worker || this.running || this.settling || !this.result) return Promise.reject(new Error('Complete an inspection first.'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {resolve, reject});
      this.worker.postMessage({action, requestId, ...values});
    });
  }
  async cancel() {
    if (!this.running) return false;
    if (this.cancelling) { await this.done; return false; }
    this.cancelling = true;
    this.worker.postMessage({action: 'cancel'});
    let timer;
    await Promise.race([this.done, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
    clearTimeout(timer);
    try {
      // Completion can win the race with cancellation. Keep its evidence worker.
      if (!this.running && this.result) return false;
      if (this.running) await this.finish(this.worker, 'cancelled', null);
      else await this.done;
      return true;
    } finally { this.cancelling = false; }
  }
  async dispose() {
    const worker = this.worker;
    this.worker = null;
    const directories = [...this.temporary];
    this.temporary.clear();
    for (const request of this.pending.values()) request.reject(new Error('Inspection closed.'));
    this.pending.clear();
    if (worker) await worker.terminate();
    for (const directory of directories) await fs.rm(directory, {recursive: true, force: true});
  }
}
module.exports = {JobController};
