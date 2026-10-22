'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const assert = require('node:assert/strict');
const {conversation, fixtureZip} = require('../tests/helpers/conversion.cjs');
const run = promisify(execFile);

async function main() {
  if (!['linux', 'win32'].includes(process.platform)) throw new Error('This test targets Windows and Linux native packages.');
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--dir')) throw new Error('Usage: node scripts/test-packaged.cjs [--dir UNPACKED_DIRECTORY]');
  const directory = path.resolve(args[1] || path.join(__dirname, '..', 'dist', process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-packaged-test-'));
  try {
    const input = path.join(temporary, 'export.zip'), output = path.join(temporary, 'output');
    await fs.mkdir(output);
    const bytes = fixtureZip([['conversations.json', JSON.stringify([conversation('packaged-synthetic')])]]);
    await fs.writeFile(input, bytes);
    const executable = path.join(directory, process.platform === 'win32' ? 'ChatGPT-Export-Processor.exe' : 'chatgpt-export-processor');
    const env = {...process.env, XDG_CONFIG_HOME: path.join(temporary, 'config')};
    if (process.platform === 'win32') {
      env.APPDATA = path.join(temporary, 'config');
      env.LOCALAPPDATA = path.join(temporary, 'config');
    }
    delete env.ELECTRON_RUN_AS_NODE;
    // Explicit headless flags are needed before Chromium's platform startup.
    // The privileged-container sandbox exception is confined to this test.
    const flags = process.platform === 'linux' ? ['--ozone-platform=headless', '--disable-gpu', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])] : [];
    const version = await run(executable, [...flags, '--cli', '--version'], {env, timeout: 30000});
    assert.equal(version.stdout.trim(), '1.0.0');
    await run(executable, [...flags, '--cli', 'convert', input, '--output-dir', output], {env, timeout: 60000});
    const directories = await fs.readdir(output);
    assert.equal(directories.length, 1);
    const generated = path.join(output, directories[0]);
    const report = JSON.parse(await fs.readFile(path.join(generated, 'validation-report.json'), 'utf8'));
    assert.equal(report.status, 'PASS', JSON.stringify(report.findings));
    assert.equal(report.coverage.complete, true);
    assert.deepEqual(await fs.readFile(input), bytes);
    const inspectionEntrypoint = process.platform === 'linux' ? path.join(directory, 'bin', 'chatgpt-export-processor') : executable;
    const inspection = await run(inspectionEntrypoint, [...flags, '--cli', 'inspect', '--original', input, '--bundle', path.join(generated, 'chatgpt-export-processed.zip'), '--profile', 'all'], {env, timeout: 60000});
    assert.match(inspection.stdout, /Passed/);
    console.log(JSON.stringify({passed: true, platform: process.platform, version: version.stdout.trim(), asarRuntime: true, nativeBinary: true, binSymlink: process.platform === 'linux', conversion: 'PASS', inspection: 'PASS', sourceUnchanged: true}, null, 2));
  } finally { await fs.rm(temporary, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
