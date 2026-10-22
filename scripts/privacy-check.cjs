'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const ignored = new Set(['node_modules', 'dist', 'out', '.git', 'coverage', 'test-results', 'playwright-report']);
const binary = new Set(['.png', '.ico', '.pdf']);
const unpublishedArtifacts = new Set(['.zip', '.tar', '.tgz', '.gz', '.deb', '.exe']);
const exportFilename = /^(?:conversations(?:-\d+|-index)?\.json|chat(?:-index)?\.html?|user\.json|message_feedback\.json|shared_conversations\.json|model_comparisons\.json|validation-report\.(?:json|html|csv)|SHA256SUM\.txt)$/i;
const exempt = new Set(['docs/THIRD-PARTY-NOTICES.md']);
const rules = [
  ['credential', new RegExp('github' + '_pat_[A-Za-z0-9_]{15,}|gh[pousr]_[A-Za-z0-9]{20,}')],
  ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['private filesystem path', /(?:\/workspace\/|\/home\/[^\s/'"]+\/|\/Users\/[^\s/'"]+\/|[A-Z]:\\Users\\)/],
];
function walk(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => {
    if (ignored.has(e.name)) return [];
    const file = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error('Unexpected source symlink: ' + path.relative(root, file));
    return e.isDirectory() ? walk(file) : [file];
  });
}
const findings = [];
let scanned = 0;
for (const file of walk(root)) {
  const name = path.relative(root, file).split(path.sep).join('/');
  const extension = path.extname(file).toLowerCase();
  if (unpublishedArtifacts.has(extension)) {
    findings.push({file: name, rule: 'archive or executable outside an excluded build directory'});
    continue;
  }
  if (exportFilename.test(path.basename(file))) {
    findings.push({file: name, rule: 'ChatGPT export or generated report in publication source'});
    continue;
  }
  if (exempt.has(name) || binary.has(extension)) continue;
  const content = fs.readFileSync(file, 'utf8');
  if (content.includes('\0')) continue;
  scanned++;
  for (const [rule, expression] of rules) if (expression.test(content)) findings.push({file: name, rule});
}
if (findings.length) {
  for (const item of findings) console.error(`${item.file}: ${item.rule}`);
  console.error(`FAIL: ${findings.length} publication privacy finding(s). Values are intentionally not printed.`);
  process.exitCode = 1;
} else console.log(`PASS: publication source excludes export/report files and archives; ${scanned} text files checked for embedded credentials, email addresses, and private paths.`);
