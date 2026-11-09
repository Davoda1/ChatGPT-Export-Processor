'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const syncFs = require('node:fs');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {prepare, names, manifest, verifiedSource, plan, publish} = require('../scripts/publish-release.cjs');

test('release sources and one manifest come from the exact clean tagged master commit', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-publication-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true, maxRetries: 5}));
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git(['init', '-b', 'master']);
  await fs.writeFile(path.join(root, '.gitignore'), 'dist/\n');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({version: '1.1.0', author: 'davoda1'}));
  await fs.writeFile(path.join(root, 'README.md'), 'Synthetic public source.\n');
  git(['add', '.']);
  git(['-c', 'user.name=davoda1', '-c', 'user.email=release-test', 'commit', '-m', 'Synthetic release']);
  const sha = git(['rev-parse', 'HEAD']);
  git(['tag', 'v1.1.0']);
  git(['update-ref', 'refs/remotes/origin/master', sha]);
  assert.deepEqual(verifiedSource(root, sha), {version: '1.1.0', tag: 'v1.1.0', sha});
  assert.deepEqual(plan(root, sha, 'push', 'refs/heads/master', undefined, fakeGitHub({releases:[{tag_name:'v1.1.0',draft:false}]}).options), {build: false, publish: false});
  assert.deepEqual(plan(root, sha, 'push', 'refs/tags/v1.1.0', undefined, fakeGitHub().options), {build: true, publish: true});
  assert.deepEqual(plan(root, sha, 'workflow_dispatch', 'refs/heads/master', 'false', fakeGitHub().options), {build: true, publish: false});
  assert.deepEqual(plan(root, sha, 'workflow_dispatch', 'refs/heads/master', 'true', fakeGitHub().options), {build: true, publish: true});
  assert.throws(() => plan(root, sha, 'push', 'refs/tags/v9.9.9', undefined, fakeGitHub().options), /must match the package version/);
  git(['tag', '-d', 'v1.1.0']);
  assert.deepEqual(plan(root, sha, 'push', 'refs/heads/master', undefined, fakeGitHub().options), {build: true, publish: true});
  assert.deepEqual(verifiedSource(root, sha, {allowMissingTag: true}), {version: '1.1.0', tag: 'v1.1.0', sha});
  git(['tag', 'v1.1.0']);
  assert.throws(() => verifiedSource(root, '0'.repeat(40)), /verified commit exactly/);
  await fs.appendFile(path.join(root, 'README.md'), 'Uncommitted content.\n');
  assert.throws(() => verifiedSource(root, sha), /must be clean/);
  git(['checkout', '--', 'README.md']);
  const directory = path.join(root, 'dist');
  await fs.mkdir(directory);
  const assets = names('1.1.0');
  for (const name of assets.filter(name => !name.includes('-Source.'))) await fs.writeFile(path.join(directory, name), 'Synthetic native package.\n');
  await fs.writeFile(path.join(directory, 'unexpected.txt'), 'Unexpected');
  await assert.rejects(prepare(root, directory, sha), /Unexpected or missing release asset/);
  await fs.unlink(path.join(directory, 'unexpected.txt'));
  await prepare(root, directory, sha);
  assert.deepEqual((await fs.readdir(directory)).sort(), [...assets, 'SHA256SUM.txt'].sort());
  const checksums = await fs.readFile(path.join(directory, 'SHA256SUM.txt'), 'utf8');
  assert.equal(checksums, await manifest(directory, assets));
  assert.equal(checksums.trim().split('\n').length, 5);
  const zip = await fs.readFile(path.join(directory, assets.find(name => name.endsWith('-Source.zip'))));
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const tar = zlib.gunzipSync(await fs.readFile(path.join(directory, assets.find(name => name.endsWith('-Source.tar.gz')))));
  assert.ok(tar.includes(Buffer.from('ChatGPT-Export-Processor-1.1.0/README.md')));
  assert.ok(tar.includes(Buffer.from('Synthetic public source.')));
  assert.ok(!tar.includes(Buffer.from('Synthetic native package.')), 'Build outputs must not enter exact-tree source archives.');
  await assert.rejects(prepare(root, directory, sha), /Unexpected or missing release asset/, 'A prepared release is never silently replaced.');
});


function fakeGitHub(initial = {}) {
  const state = {releases: structuredClone(initial.releases || []), tag: initial.tag || null, nextId: 500, calls: [], failUpload: initial.failUpload || 0, corruptUpload: Boolean(initial.corruptUpload), uploads: 0};
  function runGh(args, options) {
    assert.equal(args[0], 'api');
    assert.equal(args[args.indexOf('--hostname') + 1], 'github.com');
    const method = args[args.indexOf('--method') + 1];
    const endpoint = args[args.indexOf('--method') + 2];
    const prefix = 'repos/synthetic/project/';
    const isUpload = endpoint.startsWith('https://uploads.github.com/');
    const route = (isUpload ? endpoint.slice('https://uploads.github.com/'.length) : endpoint).slice(prefix.length);
    assert.ok((isUpload ? endpoint.slice('https://uploads.github.com/'.length) : endpoint).startsWith(prefix));
    const body = options.input ? JSON.parse(options.input) : undefined;
    const input = args.includes('--input') ? args[args.indexOf('--input') + 1] : null;
    state.calls.push({method, route, body, isUpload});
    const respond = value => JSON.stringify(value);
    const missing = () => {const error = new Error('Synthetic missing resource'); error.stderr = '(HTTP 404)'; throw error;};
    if (route.startsWith('releases/tags/')) throw new Error('Draft lookup must never use the by-tag endpoint.');
    if (method === 'GET' && route.startsWith('releases?')) {
      const page = Number(new URLSearchParams(route.split('?')[1]).get('page'));
      return respond(state.releases.slice((page - 1) * 100, page * 100));
    }
    if (method === 'GET' && route === 'git/ref/tags/v1.1.0') return state.tag ? respond({object:{type:'commit',sha:state.tag}}) : missing();
    if (method === 'POST' && route === 'git/refs') {state.tag = body.sha; return respond({object:{type:'commit',sha:state.tag}});}
    if (method === 'POST' && route === 'releases') {
      const release = {id: ++state.nextId, ...body, assets: []};
      state.releases.push(release); return respond(release);
    }
    let match = /^releases\/(\d+)$/.exec(route);
    if (match) {
      const release = state.releases.find(item => item.id === Number(match[1]));
      if (!release) return missing();
      if (method === 'GET') return respond(release);
      if (method === 'PATCH') {Object.assign(release, body); return respond(release);}
    }
    match = /^releases\/(\d+)\/assets\?name=(.+)$/.exec(route);
    if (method === 'POST' && match) {
      assert.ok(isUpload, 'Uploads use the full GitHub uploads URL with GitHub.com authentication.');
      assert.ok(args.includes('Content-Type: application/octet-stream'));
      state.uploads++;
      if (state.failUpload === state.uploads) throw new Error('Synthetic interrupted upload');
      const release = state.releases.find(item => item.id === Number(match[1]));
      assert.ok(release && release.draft);
      const name = decodeURIComponent(match[2]);
      assert.ok(!release.assets.some(asset => asset.name === name));
      const bytes = syncFs.readFileSync(input);
      const asset = {id: ++state.nextId, name, size: bytes.length, state:'uploaded', digest:'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')};
      if (state.corruptUpload) asset.digest = 'sha256:' + '0'.repeat(64);
      release.assets.push(asset); return respond(asset);
    }
    match = /^releases\/assets\/(\d+)$/.exec(route);
    if (method === 'DELETE' && match) {
      for (const release of state.releases) release.assets = release.assets.filter(asset => asset.id !== Number(match[1]));
      return '';
    }
    throw new Error('Unexpected synthetic GitHub operation: ' + method + ' ' + route);
  }
  return {state, options: {repository:'synthetic/project', runGh}};
}

async function publicationFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-release-api-test-'));
  t.after(() => fs.rm(root, {recursive:true,force:true,maxRetries:5}));
  const git = args => execFileSync('git', args, {cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(['init','-b','master']);
  await fs.writeFile(path.join(root,'.gitignore'),'dist/\n');
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({version:'1.1.0',author:'davoda1'}));
  await fs.writeFile(path.join(root,'CHANGELOG.md'),'# Changelog\n\n## 1.1.0 — Synthetic release\n\n- Synthetic release test.\n');
  git(['add','.']); git(['-c','user.name=davoda1','-c','user.email=release-test','commit','-m','Synthetic source']);
  const sha=git(['rev-parse','HEAD']);
  git(['tag','v1.1.0']); git(['update-ref','refs/remotes/origin/master',sha]);
  const directory=path.join(root,'dist'); await fs.mkdir(directory);
  for (const name of names('1.1.0').filter(name=>!name.includes('-Source.'))) await fs.writeFile(path.join(directory,name),'Synthetic package '+name);
  await prepare(root,directory,sha);
  const assetNames=[...names('1.1.0'),'SHA256SUM.txt'];
  const assets=[];
  for (const [index,name] of assetNames.entries()) {
    const bytes=await fs.readFile(path.join(directory,name));
    assets.push({id:index+1,name,size:bytes.length,state:'uploaded',digest:'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')});
  }
  return {root,sha,directory,assets,release:{id:42,tag_name:'v1.1.0',target_commitish:sha,draft:true,assets:[]}};
}

test('publication creates, resumes, and verifies releases by ID without overwriting public content', async t => {
  const fixture=await publicationFixture(t);
  const {root,sha,directory,assets,release}=fixture;
  const mutations=state=>state.calls.filter(call=>call.method!=='GET');
  await t.test('creates one draft, uploads all six assets, and publishes by numeric ID', async()=>{
    const api=fakeGitHub();
    await publish(root,directory,sha,api.options);
    assert.equal(api.state.releases.length,1);
    assert.equal(api.state.releases[0].draft,false);
    assert.equal(api.state.releases[0].assets.length,6);
    assert.equal(api.state.uploads,6);
    const patch=api.state.calls.find(call=>call.method==='PATCH');
    assert.equal(patch.route,'releases/'+api.state.releases[0].id);
    assert.deepEqual(patch.body,{draft:false,make_latest:'true'});
  });
  await t.test('an interrupted upload resumes the same draft and retains verified assets', async()=>{
    const api=fakeGitHub({tag:sha,failUpload:3});
    await assert.rejects(publish(root,directory,sha,api.options),/interrupted upload/);
    assert.equal(api.state.releases.length,1); assert.equal(api.state.releases[0].draft,true);
    assert.equal(api.state.releases[0].assets.length,2);
    const id=api.state.releases[0].id;
    await publish(root,directory,sha,api.options);
    assert.equal(api.state.releases.length,1); assert.equal(api.state.releases[0].id,id);
    assert.equal(api.state.releases[0].draft,false); assert.equal(api.state.uploads,7);
    assert.equal(api.state.calls.filter(call=>call.method==='POST'&&call.route==='releases').length,1);
  });
  await t.test('mismatching assets can be replaced only in the exact-commit draft', async()=>{
    const incorrect={...assets[0],digest:'sha256:'+'0'.repeat(64)};
    const api=fakeGitHub({tag:sha,releases:[{...release,assets:[incorrect,...assets.slice(1)]}]});
    await publish(root,directory,sha,api.options);
    assert.equal(api.state.uploads,1);
    assert.equal(api.state.calls.filter(call=>call.method==='DELETE').length,1);
    assert.equal(api.state.releases[0].draft,false);
  });
  await t.test('a verified already-published release is a read-only successful retry', async()=>{
    const api=fakeGitHub({tag:sha,releases:[{...release,draft:false,assets}]});
    const result=await publish(root,directory,sha,api.options);
    assert.equal(result.alreadyPublished,true); assert.deepEqual(mutations(api.state),[]);
  });
  await t.test('public mismatch, wrong commit, duplicate drafts, and unrelated assets fail without mutation', async()=>{
    const cases=[
      [{...release,draft:false,assets:[{...assets[0],size:1},...assets.slice(1)]}],
      [{...release,target_commitish:'0'.repeat(40),assets}],
      [release,{...release,id:43}],
      [{...release,assets:[{id:9,name:'unrelated.txt'}]}],
    ];
    for(const releases of cases){const api=fakeGitHub({tag:sha,releases});await assert.rejects(publish(root,directory,sha,api.options));assert.deepEqual(mutations(api.state),[]);}
  });
  await t.test('incorrect uploaded digest leaves a draft and never publishes', async()=>{
    const api=fakeGitHub({tag:sha,releases:[release],corruptUpload:true});
    await assert.rejects(publish(root,directory,sha,api.options),/digest, size, or state differs/);
    assert.equal(api.state.releases[0].draft,true);
    assert.equal(api.state.calls.some(call=>call.method==='PATCH'),false);
  });
  await t.test('planning retries a bare tag or matching draft, and skips only a published version', ()=>{
    assert.deepEqual(plan(root,sha,'push','refs/heads/master',undefined,fakeGitHub({tag:sha}).options),{build:true,publish:true});
    assert.deepEqual(plan(root,sha,'push','refs/heads/master',undefined,fakeGitHub({tag:sha,releases:[release]}).options),{build:true,publish:true});
    assert.deepEqual(plan(root,sha,'push','refs/heads/master',undefined,fakeGitHub({tag:sha,releases:[{...release,draft:false,assets}]}).options),{build:false,publish:false});
    assert.throws(()=>plan(root,sha,'push','refs/heads/master',undefined,fakeGitHub({tag:sha,releases:[{...release,target_commitish:'0'.repeat(40)}]}).options),/different commit/);
  });
  await t.test('release discovery reads subsequent listing pages', async()=>{
    const others=Array.from({length:100},(_,index)=>({id:1000+index,tag_name:'v0.0.'+index,draft:false}));
    const api=fakeGitHub({tag:sha,releases:[...others,{...release,draft:false,assets}]});
    await publish(root,directory,sha,api.options);
    assert.ok(api.state.calls.some(call=>call.route==='releases?per_page=100&page=2'));
    assert.deepEqual(mutations(api.state),[]);
  });
  await t.test('a mismatched remote tag fails before any release mutation', async()=>{
    const api=fakeGitHub({tag:'0'.repeat(40),releases:[release]});
    await assert.rejects(publish(root,directory,sha,api.options),/remote release tag/);
    assert.deepEqual(mutations(api.state),[]);
  });
  await t.test('later master commits skip a published version but cannot move an unpublished version tag', async()=>{
    const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    await fs.writeFile(path.join(root,'maintenance.txt'),'Synthetic later source.\n');
    git(['add','maintenance.txt']);
    git(['-c','user.name=davoda1','-c','user.email=release-test','commit','-m','Synthetic maintenance']);
    const later=git(['rev-parse','HEAD']); git(['update-ref','refs/remotes/origin/master',later]);
    const draftApi=fakeGitHub({tag:sha,releases:[release]});
    assert.throws(()=>plan(root,later,'push','refs/heads/master',undefined,draftApi.options),/tag must identify the verified commit/);
    assert.deepEqual(mutations(draftApi.state),[]);
    const publishedApi=fakeGitHub({tag:sha,releases:[{...release,draft:false,assets}]});
    assert.deepEqual(plan(root,later,'push','refs/heads/master',undefined,publishedApi.options),{build:false,publish:false});
    assert.deepEqual(mutations(publishedApi.state),[]);
  });
});
