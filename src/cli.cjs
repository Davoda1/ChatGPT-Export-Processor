'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {JobController} = require('./main/job-controller.cjs');
const {writeReportExclusive} = require('./main/file-policy.cjs');
const VERSION = require('../package.json').version;
const HELP = `ChatGPT Export Processor ${VERSION}

Convert and independently validate local ChatGPT exports.

  --help | --version
  convert EXPORT.zip --output-dir DIRECTORY [--no-standard] [--no-document] [--no-chat-message]
  inspect [--original EXPORT.zip|conversations.json] [--json FILE] [--html FILE]
          [--bundle FILE.zip] [--profile auto|all|email]
          [--report NEW_FILE] [--format json|html|csv]

Packaged application: add --cli before the command.
Conversion creates a fresh subfolder. Existing files are never overwritten.
Inspection reads inputs only. Reports can contain filenames, titles, and IDs.
Exit codes: 0 passed; 2 review needed; 3 failed; 4 limited coverage; 1 input/runtime error; 130 cancelled.
`;
function parseArgs(args) {
  if (!args.length || args.includes('--help') || args[0] === '-h') return {help: true};
  if (args.length === 1 && args[0] === '--version') return {version: true};
  const [command, ...rest] = args;
  if (!['convert', 'inspect'].includes(command)) throw new Error('Unknown command. Use --help for usage.');
  const spec = {mode: command, profile: 'auto', options: {standard: true, document: true, chatMessage: true}};
  let report = null, format = 'json';
  const used = new Set();
  const values = {'--output-dir': 'outputDir', '--original': 'original', '--json': 'indexJson', '--html': 'indexHtml', '--bundle': 'bundle', '--profile': 'profile', '--report': 'report', '--format': 'format'};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (command === 'convert' && !arg.startsWith('-') && !spec.input) { spec.input = path.resolve(arg); continue; }
    if (used.has(arg)) throw new Error(`Repeated option: ${arg}`);
    used.add(arg);
    if (values[arg]) {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === '--report') report = path.resolve(value);
      else if (arg === '--format') format = value;
      else if (arg === '--profile') spec.profile = value;
      else spec[values[arg]] = path.resolve(value);
    } else if (command === 'convert' && ['--no-standard', '--no-document', '--no-chat-message'].includes(arg)) {
      spec.options[{'--no-standard': 'standard', '--no-document': 'document', '--no-chat-message': 'chatMessage'}[arg]] = false;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!['json', 'html', 'csv'].includes(format)) throw new Error('Report format must be json, html, or csv.');
  if (!['auto', 'all', 'email'].includes(spec.profile)) throw new Error('Profile must be auto, all, or email.');
  if (command === 'convert') {
    if (!spec.input || !spec.outputDir) throw new Error('Conversion requires an export ZIP and --output-dir.');
    if (path.extname(spec.input).toLowerCase() !== '.zip') throw new Error('Conversion input must be a ChatGPT export ZIP.');
    if (spec.original || spec.indexJson || spec.indexHtml || spec.bundle || report || used.has('--profile') || used.has('--format')) throw new Error('Inspection/report options cannot be used with convert. Conversion writes validation reports automatically.');
  } else {
    if (spec.outputDir) throw new Error('--output-dir is a conversion option.');
    if (spec.bundle && (spec.indexJson || spec.indexHtml)) throw new Error('Choose a bundle or separate converted files, not both.');
    if (spec.bundle) { spec.indexJson = spec.bundle; delete spec.bundle; }
    if (!spec.indexJson && !spec.indexHtml) throw new Error('Inspection requires a converted file or processed bundle.');
  }
  return {spec, report, format};
}
async function runCli(args, io = {out: console.log, error: console.error}) {
  let controller;
  let interrupted = false;
  const stop = () => { interrupted = true; controller?.cancel().catch(() => {}); };
  try {
    const options = parseArgs(args);
    if (options.help) { io.out(HELP); return 0; }
    if (options.version) { io.out(VERSION); return 0; }
    if (options.spec.outputDir && !(await fs.stat(options.spec.outputDir)).isDirectory()) throw new Error('The output parent must be an existing directory.');
    let phase = '';
    controller = new JobController(event => {
      if (event.type === 'progress' && event.value?.phase !== phase) { phase = event.value.phase; io.error(phase); }
    });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    await controller.start(options.spec);
    const event = await controller.done;
    if (event.type === 'cancelled' || interrupted) return 130;
    if (event.type === 'error') throw new Error(event.error);
    if (options.report) {
      const content = await controller.request('report', {format: options.format});
      await writeReportExclusive(options.report, content, controller.protectedFiles);
    }
    const report = event.value;
    io.out(`${report.statusLabel || report.status}: ${report.conclusion}`);
    if (controller.outputDir) io.out(`Output folder: ${controller.outputDir}`);
    return {PASS: 0, REVIEW: 2, FAIL: 3, LIMITED: 4}[report.status] ?? 4;
  } catch (error) { io.error(error.message); return interrupted ? 130 : 1; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await controller?.dispose(); }
}
if (require.main === module) runCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
module.exports = {runCli, parseArgs, HELP};
