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
function githubApi(root, {repository = process.env.GH_REPO, runGh} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || (!runGh && !process.env.GH_TOKEN)) throw new Error('GitHub release authentication and repository are required.');
  const execute = runGh || ((args, options) => run('gh', args, root, options));
  const base = `repos/${repository}`;
  function request(method, route, {body, file} = {}) {
    const endpoint = file ? `https://uploads.github.com/${base}/${route}` : `${base}/${route}`;
    const args = ['api', '--hostname', 'github.com', '--method', method, endpoint, '--header', 'Accept: application/vnd.github+json'];
    const options = {stdio: ['pipe', 'pipe', 'pipe']};
    if (file) args.push('--header', 'Content-Type: application/octet-stream', '--input', file);
    else if (body !== undefined) { args.push('--input', '-'); options.input = JSON.stringify(body); }
    const text = execute(args, options).trim();
    return text ? JSON.parse(text) : null;
  }
  return request;
}
function findRelease(api, tag) {
  const matches = [];
  for (let page = 1; page <= 100; page++) {
    // The by-tag endpoint excludes drafts. Listing authenticated releases is
    // required for safe discovery; every subsequent operation uses numeric IDs.
    const releases = api('GET', `releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error('Unexpected GitHub release listing.');
    matches.push(...releases.filter(release => release.tag_name === tag));
    if (matches.length > 1) throw new Error('Multiple releases use this tag; resolve the duplicate drafts before retrying.');
    if (releases.length < 100) return matches[0] || null;
  }
  throw new Error('Release listing exceeded its pagination limit.');
}
function plan(root, expectedSha, eventName, ref, requestedPublish, githubOptions = {}) {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version) || metadata.author !== 'davoda1') throw new Error('Unexpected release version or maintainer.');
  const tag = 'v' + metadata.version;
  if (!['push', 'workflow_dispatch'].includes(eventName)) throw new Error('Unsupported release trigger.');
  if (eventName === 'push' && ref !== 'refs/heads/master' && ref !== `refs/tags/${tag}`) throw new Error('The pushed tag must match the package version.');
  const existing = findRelease(githubApi(root, githubOptions), tag);
  // A tag or draft is not a completed release. Later master maintenance may
  // skip a published version, but an unpublished version must still be verified.
  if (eventName === 'push' && ref === 'refs/heads/master' && existing && existing.draft === false) return {build: false, publish: false};
  const source = verifiedSource(root, expectedSha, {allowMissingTag: true});
  if (existing && existing.target_commitish !== source.sha) throw new Error('The existing release belongs to a different commit; tags and releases will not be moved.');
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
function numericId(value, kind) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid GitHub ${kind} identifier.`);
  return value;
}
function verifyReleaseRecord(release, source, expectedNames) {
  numericId(release?.id, 'release');
  if (release.tag_name !== source.tag || release.target_commitish !== source.sha || typeof release.draft !== 'boolean') throw new Error('Only a release for this exact tag and verified commit may be used.');
  if (!Array.isArray(release.assets)) throw new Error('Missing release asset inventory.');
  const names = release.assets.map(asset => asset.name);
  if (new Set(names).size !== names.length || names.some(name => !expectedNames.includes(name))) throw new Error('Existing release contains unrelated or duplicate assets; refusing to change it.');
}
function matchingAsset(asset, expected) {
  return asset.state === 'uploaded' && asset.size === expected.size && asset.digest === 'sha256:' + expected.hash;
}
function verifyUploaded(release, source, expected) {
  verifyReleaseRecord(release, source, [...expected.keys()]);
  if (release.assets.length !== expected.size) throw new Error('Release asset inventory is incomplete.');
  for (const asset of release.assets) if (!matchingAsset(asset, expected.get(asset.name))) throw new Error('Uploaded release asset digest, size, or state differs.');
}
async function publish(root, directory, expectedSha, githubOptions = {}) {
  const source = verifiedSource(root, expectedSha, {allowMissingTag: true});
  const assetNames = names(source.version);
  const allAssets = [...assetNames, 'SHA256SUM.txt'];
  await inventory(directory, allAssets);
  if (await fsp.readFile(path.join(directory, 'SHA256SUM.txt'), 'utf8') !== await manifest(directory, assetNames)) throw new Error('Release assets do not match the checksum manifest.');
  const notesText = await releaseNotes(root, source.version);
  const expected = new Map();
  for (const name of allAssets) {
    const file = path.join(directory, name);
    expected.set(name, {file, size: (await fsp.stat(file)).size, hash: await digest(file)});
  }
  const api = githubApi(root, githubOptions);
  let release = findRelease(api, source.tag);
  if (release) {
    verifyReleaseRecord(release, source, allAssets);
    release = api('GET', `releases/${numericId(release.id, 'release')}`);
    verifyReleaseRecord(release, source, allAssets);
  }
  let remoteTag;
  try { remoteTag = api('GET', `git/ref/tags/${source.tag}`); }
  catch (error) { if (!String(error.stderr || '').includes('(HTTP 404)')) throw error; }
  if (remoteTag) {
    let object = remoteTag.object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
      if (!/^[a-f0-9]{40}$/.test(object.sha)) throw new Error('Invalid annotated tag object.');
      object = api('GET', `git/tags/${object.sha}`).object;
    }
    if (object?.type !== 'commit' || object.sha !== source.sha) throw new Error('The remote release tag must identify the verified commit.');
  }
  if (release && !release.draft) {
    if (!remoteTag) throw new Error('Published release tag is missing; refusing to modify it.');
    verifyUploaded(release, source, expected);
    return {...source, alreadyPublished: true};
  }
  if (!remoteTag) api('POST', 'git/refs', {body: {ref: `refs/tags/${source.tag}`, sha: source.sha}});
  if (!release) {
    release = api('POST', 'releases', {body: {tag_name: source.tag, target_commitish: source.sha, draft: true, name: `ChatGPT Export Processor ${source.version}`, body: notesText}});
    verifyReleaseRecord(release, source, allAssets);
    if (!release.draft) throw new Error('New release must remain a draft until uploads are verified.');
  }
  const releaseId = numericId(release.id, 'release');
  for (const [name, file] of expected) {
    const existing = release.assets.find(asset => asset.name === name);
    if (existing && matchingAsset(existing, file)) continue;
    // Only mismatching assets belonging to this exact unpublished release can
    // be replaced. Completed uploads are retained when resuming a partial run.
    if (existing) api('DELETE', `releases/assets/${numericId(existing.id, 'asset')}`);
    const uploaded = api('POST', `releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {file: file.file});
    if (uploaded?.name !== name || !matchingAsset(uploaded, file)) throw new Error('Uploaded release asset digest, size, or state differs.');
  }
  const uploaded = api('GET', `releases/${releaseId}`);
  if (!uploaded.draft) throw new Error('Release changed during upload; refusing to change a published release.');
  verifyUploaded(uploaded, source, expected);
  const published = api('PATCH', `releases/${releaseId}`, {body: {draft: false, make_latest: 'true'}});
  if (published.draft) throw new Error('GitHub did not publish the verified release.');
  verifyUploaded(published, source, expected);
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
module.exports = {names, digest, manifest, verifiedSource, plan, prepare, releaseNotes, githubApi, findRelease, publish};
