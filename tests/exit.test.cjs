'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {exitAfterReady} = require('../src/main/exit.cjs');

test('application exit waits for readiness and a later timer turn', async () => {
  let ready;
  const readiness = new Promise(resolve => {ready = resolve;});
  const exits = [];
  const completion = exitAfterReady({whenReady: () => readiness, exit: code => exits.push(code)}, 0);
  await Promise.resolve();
  assert.deepEqual(exits, []);
  ready();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(exits, [], 'Resolving ready must not exit in the same microtask turn.');
  await completion;
  assert.deepEqual(exits, [0]);
});

test('short commands preserve every CLI exit status after the application is already ready', async () => {
  for (const code of [0, 1, 2, 3, 4, 130]) {
    const exits = [];
    const completion = exitAfterReady({whenReady: () => Promise.resolve(), exit: value => exits.push(value)}, code);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(exits, []);
    await completion;
    assert.deepEqual(exits, [code]);
  }
});
