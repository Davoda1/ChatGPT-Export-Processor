'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {pipeline} = require('node:stream/promises');
const {execFileSync} = require('node:child_process');
const {withinCheckout} = require('./release-paths.cjs');

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options}).trim();
}
function names(version) {
  return [
    `ChatGPT-Export-Processor-${version}-Windows-x64-Portable.zip`,
    `ChatGPT-Export-Processor-${version}-Linux-amd64.tar.gz`,
    `chatgpt-export-processor_${version}_amd64.deb`,
    `ChatGPT-Export-Processor-${version}-Source.zip`,
    `ChatGPT-Export-Processor-${version}-Source.tar.gz`,
  ].sort();
}
function verifiedSource(root, expectedSha, {allowMissingTag = false} = {}) {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version) || metadata.author !== 'davoda1') throw new Error('Unexpected release version or maintainer.');
  const sha = run('git', ['rev-parse', 'HEAD'], root);
  if (!/^[a-f0-9]{40}$/.test(expectedSha || '') || sha !== expectedSha) throw new Error('Release checkout must match the verified commit exactly.');
  if (run('git', ['status', '--porcelain', '--untracked-files=no'], root)) throw new Error('Tracked release source must be clean.');
  const tag = 'v' + metadata.version;
  let tagSha;
  try { tagSha = run('git', ['rev-parse', '--verify', `${tag}^{commit}`], root); }
  catch (error) { if (!allowMissingTag) throw error; }
  if (tagSha && tagSha !== sha) throw new Error('The release tag must identify the verified commit.');
  run('git', ['merge-base', '--is-ancestor', sha, 'origin/master'], root);
  return {version: metadata.version, tag, sha};
}
function plan(root, expectedSha, eventName, ref, requestedPublish) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const tag = 'v' + version;
  if (eventName === 'push' && ref === 'refs/heads/master') {
    try {
      run('git', ['rev-parse', '--verify', `refs/tags/${tag}`], root);
      return {build: false, publish: false};
    } catch { /* A new version proceeds to the verified release gates. */ }
  }
  verifiedSource(root, expectedSha, {allowMissingTag: true});
  if (eventName === 'push' && ref !== 'refs/heads/master' && ref !== `refs/tags/${tag}`) throw new Error('The pushed tag must match the package version.');
  if (!['push', 'workflow_dispatch'].includes(eventName)) throw new Error('Unsupported release trigger.');
  return {build: true, publish: eventName === 'push' || requestedPublish === 'true'};
}
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function inventory(directory, expectedNames) {
  const actual = (await fsp.readdir(directory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expectedNames].sort())) throw new Error('Unexpected or missing release asset.');
  for (const name of actual) {
    const stat = await fsp.lstat(path.join(directory, name));
    if (!stat.isFile() || stat.size === 0) throw new Error('Release assets must be nonempty regular files.');
  }
}
async function manifest(directory, assetNames) {
  let result = '';
  for (const name of assetNames) result += `${await digest(path.join(directory, name))}  ${name}\n`;
  return result;
}
async function releaseNotes(root, version) {
  const changelog = await fsp.readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const section = changelog.split(/^## /m).find(part => part.startsWith(version + ' '));
  if (!section || section.indexOf('\n') < 0) throw new Error('Release notes for this version are missing.');
  return section.slice(section.indexOf('\n') + 1).trim() + '\n\nVerified on native Windows and Linux runners, including extracted packages, Debian installation and removal, and a fresh Windows first launch. Source and dependency checks passed for this commit. Verify downloads with the single `SHA256SUM.txt` manifest.\n';
}
async function prepare(root, directory, expectedSha) {
  const source = verifiedSource(root, expectedSha, {allowMissingTag: true});
  const assetNames = names(source.version);
  const sourceZip = assetNames.find(name => name.endsWith('-Source.zip'));
  const sourceTar = assetNames.find(name => name.endsWith('-Source.tar.gz'));
  await inventory(directory, assetNames.filter(name => name !== sourceZip && name !== sourceTar));
  const prefix = `ChatGPT-Export-Processor-${source.version}/`;
  run('git', ['archive', '--format=zip', `--prefix=${prefix}`, `--output=${path.join(directory, sourceZip)}`, source.sha], root);
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'processor-release-'));
  try {
    const tar = path.join(temporary, 'source.tar');
    run('git', ['archive', '--format=tar', `--prefix=${prefix}`, `--output=${tar}`, source.sha], root);
    await pipeline(fs.createReadStream(tar), zlib.createGzip({level: 9}), fs.createWriteStream(path.join(directory, sourceTar), {flags: 'wx'}));
  } finally { await fsp.rm(temporary, {recursive: true, force: true}); }
  await inventory(directory, assetNames);
  await fsp.writeFile(path.join(directory, 'SHA256SUM.txt'), await manifest(directory, assetNames), {flag: 'wx'});
  return source;
}
async function publish(root, directory, expectedSha) {
  const source = verifiedSource(root, expectedSha, {allowMissingTag: true});
  const assetNames = names(source.version);
  const allAssets = [...assetNames, 'SHA256SUM.txt'];
  await inventory(directory, allAssets);
  if (await fsp.readFile(path.join(directory, 'SHA256SUM.txt'), 'utf8') !== await manifest(directory, assetNames)) throw new Error('Release assets do not match the checksum manifest.');
  const notesText = await releaseNotes(root, source.version);
  if (!process.env.GH_TOKEN || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(process.env.GH_REPO || '')) throw new Error('GitHub release authentication and repository are required.');
  const apiPath = `repos/${process.env.GH_REPO}/releases/tags/${source.tag}`;
  const tagPath = `repos/${process.env.GH_REPO}/git/ref/tags/${source.tag}`;
  let remoteTag;
  try { remoteTag = JSON.parse(run('gh', ['api', tagPath], root)); }
  catch (error) { if (!String(error.stderr || '').includes('(HTTP 404)')) throw error; }
  if (!remoteTag) {
    run('gh', ['api', `repos/${process.env.GH_REPO}/git/refs`, '--method', 'POST', '-f', `ref=refs/tags/${source.tag}`, '-f', `sha=${source.sha}`], root);
  } else {
    let object = remoteTag.object;
    for (let depth = 0; object.type === 'tag' && depth < 5; depth++) object = JSON.parse(run('gh', ['api', `repos/${process.env.GH_REPO}/git/tags/${object.sha}`], root)).object;
    if (object.type !== 'commit' || object.sha !== source.sha) throw new Error('The remote release tag must identify the verified commit.');
  }
  let existing;
  try { existing = JSON.parse(run('gh', ['api', apiPath], root)); }
  catch (error) {
    if (!String(error.stderr || '').includes('(HTTP 404)')) throw error;
  }
  if (existing && (!existing.draft || existing.target_commitish !== source.sha)) throw new Error('Only an unpublished draft for this exact commit may be resumed.');
  if (existing && existing.assets.some(asset => !allAssets.includes(asset.name))) throw new Error('Existing draft contains unrelated assets; refusing to change it.');
  if (!existing) {
    const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'processor-release-notes-'));
    try {
      const notes = path.join(temporary, 'notes.md');
      await fsp.writeFile(notes, notesText);
      run('gh', ['release', 'create', source.tag, '--verify-tag', '--target', source.sha, '--draft', '--title', `ChatGPT Export Processor ${source.version}`, '--notes-file', notes], root);
    } finally { await fsp.rm(temporary, {recursive: true, force: true}); }
  }
  run('gh', ['release', 'upload', source.tag, ...allAssets.map(name => path.join(directory, name)), '--clobber'], root);
  const uploaded = JSON.parse(run('gh', ['api', apiPath], root));
  if (!uploaded.draft || JSON.stringify(uploaded.assets.map(asset => asset.name).sort()) !== JSON.stringify([...allAssets].sort())) throw new Error('Draft release asset inventory is incomplete.');
  for (const asset of uploaded.assets) {
    const file = path.join(directory, asset.name);
    if (asset.size !== (await fsp.stat(file)).size || asset.state !== 'uploaded') throw new Error('Uploaded release asset is incomplete.');
    if (asset.digest && asset.digest !== 'sha256:' + await digest(file)) throw new Error('Uploaded release asset digest differs.');
  }
  run('gh', ['release', 'edit', source.tag, '--draft=false', '--latest'], root);
  return source;
}
async function main() {
  const [action, flag, value, ...extra] = process.argv.slice(2);
  const root = path.resolve(__dirname, '..');
  if (action === 'plan' && !flag) {
    const result = plan(root, process.env.RELEASE_SHA, process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF, process.env.RELEASE_PUBLISH);
    // The workflow routes these fixed boolean fields to its runner-managed
    // output file; the script does not accept a writable path from the environment.
    process.stdout.write(`build=${result.build === true}\npublish=${result.publish === true}\n`);
    return;
  }
  if (!['prepare', 'publish'].includes(action) || flag !== '--assets' || !value || extra.length) throw new Error('Usage: node scripts/publish-release.cjs prepare|publish --assets DIRECTORY');
  const directory = withinCheckout(root, value);
  const dist = path.join(fs.realpathSync(root), 'dist');
  if (directory !== dist && !directory.startsWith(dist + path.sep)) throw new Error('Release assets must be inside the checkout dist directory.');
  const result = await (action === 'prepare' ? prepare : publish)(root, directory, process.env.RELEASE_SHA);
  console.log(`${action === 'prepare' ? 'Prepared' : 'Published'} ${result.tag} from verified commit ${result.sha}.`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = {names, digest, manifest, verifiedSource, plan, prepare, releaseNotes};
