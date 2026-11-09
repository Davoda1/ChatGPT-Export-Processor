'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {compileLinuxEntrypoint, verifyNativeBinary} = require('../scripts/linux-entrypoint.cjs');

test('installed native entrypoint execs the runtime with exact arguments, PID, exit status and signals', {skip: process.platform !== 'linux'}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-native-test-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const probe = path.join(directory, 'runtime'), source = path.join(directory, 'probe.c');
  await fs.writeFile(source, `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--signal") == 0) { raise(SIGTERM); return 1; }
  if (argc > 2 && strcmp(argv[1], "--exit") == 0) return atoi(argv[2]);
  printf("%ld\\n", (long)getpid());
  for (int i = 1; i < argc; i++) printf("%zu:%s\\n", strlen(argv[i]), argv[i]);
  return 0;
}
`);
  const compiled = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', probe], {encoding: 'utf8'});
  assert.ifError(compiled.error); assert.equal(compiled.status, 0, compiled.stderr);
  const entrypoint = path.join(directory, 'entrypoint');
  compileLinuxEntrypoint(entrypoint, probe);
  assert.ok(verifyNativeBinary(entrypoint, 'linux').isFile());
  const args = ['space separated', 'literal;$(command)', 'quoted "value"', '日本語', ''];
  const result = spawnSync(entrypoint, args, {encoding: 'utf8'});
  assert.ifError(result.error); assert.equal(result.status, 0);
  assert.equal(result.stdout, `${result.pid}\n` + args.map(value => `${Buffer.byteLength(value)}:${value}\n`).join(''));
  assert.equal(spawnSync(entrypoint, ['--exit', '23']).status, 23);
  const signalled = spawnSync(entrypoint, ['--signal']);
  assert.equal(signalled.status, null); assert.equal(signalled.signal, 'SIGTERM');
  await fs.rm(probe);
  const missing = spawnSync(entrypoint, [], {encoding: 'utf8'});
  assert.equal(missing.status, 127); assert.match(missing.stderr, /^Unable to start ChatGPT Export Processor/);
});

test('native binary verification rejects scripts and symlink entrypoints', {skip: process.platform !== 'linux'}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-native-policy-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const script = path.join(directory, 'script'), link = path.join(directory, 'link');
  await fs.writeFile(script, '#!/bin/sh\nexit 0\n', {mode: 0o755});
  await fs.symlink(script, link);
  assert.throws(() => verifyNativeBinary(script, 'linux'), /must be a native binary/);
  assert.throws(() => verifyNativeBinary(link, 'linux'), /regular native binary/);
});
