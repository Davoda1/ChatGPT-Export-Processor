'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const execute = promisify(execFile);
const version = require('../package.json').version;
const launches = 120, concurrency = 4;
const cases = [
  {name: 'version', args: ['--version'], code: 0, output: stdout => stdout.trim() === version},
  {name: 'help', args: ['--help'], code: 0, output: stdout => stdout.trimStart().startsWith(`ChatGPT Export Processor ${version}\n`)},
  {name: 'invalid command', args: ['synthetic-invalid-command'], code: 1, output: stdout => !stdout.trim(), error: stderr => stderr.split('\n').includes('Unknown command. Use --help for usage.')},
];

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--dir')) throw new Error('Usage: node scripts/test-cli-lifecycle.cjs [--dir PACKAGED_DIRECTORY]');
  if (!['win32', 'linux'].includes(process.platform)) throw new Error('Native lifecycle testing requires Windows or Linux.');
  const directory = args.length ? path.resolve(args[1]) : null;
  const executable = directory ? path.join(directory, process.platform === 'win32' ? 'ChatGPT-Export-Processor.exe' : 'chatgpt-export-processor') : require('electron');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-lifecycle-test-'));
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const failures = [];
  let next = 1, completed = 0;
  async function runCase(index) {
    const scenario = cases[index % cases.length];
    const profile = path.join(temporary, 'profile-' + index);
    await fs.mkdir(profile);
    const flags = [`--user-data-dir=${profile}`];
    if (process.platform === 'linux') {
      flags.push('--ozone-platform=headless', '--disable-gpu');
      if (process.getuid?.() === 0) flags.push('--no-sandbox');
    }
    if (!directory) flags.push(path.resolve(__dirname, '..'));
    let result;
    try {result = {...await execute(executable, [...flags, '--cli', ...scenario.args], {env, timeout: 30000, maxBuffer: 65536}), code: 0};}
    catch (error) {result = error;}
    const stdout = String(result.stdout || '').replace(/\r\n/g, '\n');
    const stderr = String(result.stderr || '').replace(/\r\n/g, '\n');
    const expectedErrorMatches = !scenario.error || scenario.error(stderr);
    if (result.code !== scenario.code || result.signal || result.killed || !scenario.output(stdout) || !expectedErrorMatches) {
      const code = Number.isInteger(result.code) ? result.code : null;
      throw new Error('Native CLI lifecycle failed: ' + JSON.stringify({
        launch: index + 1, scenario: scenario.name, expectedExitCode: scenario.code, exitCode: code,
        windowsStatus: process.platform === 'win32' && code !== null ? '0x' + (code >>> 0).toString(16).padStart(8, '0') : null,
        systemError: typeof result.code === 'string' && /^E[A-Z0-9_]+$/.test(result.code) ? result.code : null,
        signal: result.signal || null, killed: Boolean(result.killed),
        stdoutMatches: scenario.output(stdout), expectedErrorMatches,
        stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
      }));
    }
    completed++;
  }
  try {
    // The first process is a cold launch. Subsequent fresh profiles exercise
    // startup/exit under bounded parallel load; any failed launch fails the run.
    await runCase(0);
    await Promise.all(Array.from({length: concurrency}, async () => {
      while (next < launches && failures.length === 0) {
        const index = next++;
        try {await runCase(index);} catch (error) {failures.push(error);}
      }
    }));
    if (failures.length) throw failures[0];
    console.log(JSON.stringify({passed: true, platform: process.platform, launches: completed, freshProfiles: completed, concurrency, cases: cases.map(value => value.name), retries: 0, packagedRuntime: Boolean(directory)}, null, 2));
  } finally {await fs.rm(temporary, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});}
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
