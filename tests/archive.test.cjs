'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib'),CRC=require('crc-32');
const {resolveInputs}=require('../src/core/inputs.cjs'),{audit}=require('../src/core/audit.cjs');
function zip(entries){const local=[],central=[];let offset=0;for(const [name,text,badCrc]of entries){const n=Buffer.from(name),data=Buffer.from(text),packed=zlib.deflateRawSync(data),crc=((CRC.buf(data)>>>0)^(badCrc?1:0))>>>0;const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(8,8);h.writeUInt32LE(crc,14);h.writeUInt32LE(packed.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(n.length,26);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(8,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(packed.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);local.push(h,n,packed);central.push(c,n);offset+=h.length+n.length+packed.length;}const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);}
function file(t,entries){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'export-processor-ziptest-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const p=path.join(dir,'bundle.zip');fs.writeFileSync(p,zip(entries));return p;}
test('ZIP bundle roles are selected and CRC-checked without extraction paths from archive',async t=>{const p=file(t,[['nested/conversations.json','[]'],['nested/conversations-index.json','[]'],['nested/chat-index.html','const jsonData = [];']]);const r=await resolveInputs({original:p},()=>{});t.after(()=>r.cleanup());assert.equal(r.descriptors.length,3);assert(r.descriptors.every(x=>x.file.startsWith(r.temp)));assert(r.byRole.indexHtml);});
test('ZIP CRC corruption is rejected',async t=>{await assert.rejects(()=>resolveInputs({original:file(t,[['conversations-index.json','[]',true]])},()=>{}),/CRC/);});
test('ambiguous index members are rejected',async t=>{await assert.rejects(()=>resolveInputs({original:file(t,[['a/conversations-index.json','[]'],['b/conversations-index.json','[]']])},()=>{}),/Ambiguous/);});
test('ZIP traversal filename is rejected before any file is written outside the session',async t=>{await assert.rejects(()=>resolveInputs({original:file(t,[['../conversations-index.json','[]']])},()=>{}));});
test('multipart original exports are naturally ordered',async t=>{const r=await resolveInputs({original:file(t,[['conversations-10.json','[]'],['conversations-2.json','[]'],['conversations-index.json','[]']])},()=>{});t.after(()=>r.cleanup());assert.deepEqual(r.byRole.original.map(x=>x.entry),['conversations-2.json','conversations-10.json']);});
test('failed parsing is never reported as a source-comparison PASS',async t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'export-processor-parse-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=path.join(dir,'a.json'),b=path.join(dir,'b.json');fs.writeFileSync(a,'[{"id":"1","mapping":{}}]');fs.writeFileSync(b,'[{"id":"1","mapping":{}},');const r=await audit({original:a,indexJson:b});assert.equal(r.report.checks.find(x=>x.name==='Source comparison').status,'INCOMPLETE');});
module.exports={zip};

test('ZIP symbolic links are rejected even for unselected entries', async t => {
  const p = file(t, [['ignored.txt','target'], ['conversations-index.json','[]']]);
  const bytes = fs.readFileSync(p), central = bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  bytes.writeUInt16LE((3 << 8) | 20, central + 4);
  bytes.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38);
  fs.writeFileSync(p, bytes);
  await assert.rejects(() => resolveInputs({indexJson:p}), /symbolic links/);
});
test('ZIP encrypted data is rejected', async t => {
  const p = file(t, [['conversations-index.json','[]']]), bytes = fs.readFileSync(p);
  const central = bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  bytes.writeUInt16LE(1,6);bytes.writeUInt16LE(1,central+8);fs.writeFileSync(p,bytes);
  await assert.rejects(() => resolveInputs({indexJson:p}), /Encrypted/);
});
test('ZIP size and entry-count limits are enforced before extraction', async t => {
  const {unpackZip} = require('../src/core/inputs.cjs');
  const p = file(t, [['conversations-index.json','[]'],['chat-index.html','const jsonData = [];']]);
  const dest = path.join(path.dirname(p),'out');fs.mkdirSync(dest);
  await assert.rejects(() => unpackZip(p,dest,()=>{},{maxEntry:1}), /size limits/);
  await assert.rejects(() => unpackZip(p,dest,()=>{},{maxEntries:1}), /entry-count/);
  assert.deepEqual(fs.readdirSync(dest), []);
});
test('unsafe archive paths are refused regardless of whether the entry is selected', async t => {
  for (const name of ['/absolute.txt','C:/drive.txt','bad\\path.txt','bad\x00name.txt']) {
    const p=file(t, [[name,'unused'],['conversations-index.json','[]']]);
    await assert.rejects(()=>resolveInputs({indexJson:p}));
  }
});
test('cancelled ZIP input resolution removes its private temporary directory', async t => {
  const p=file(t,[['conversations-index.json','[]']]), controller=new AbortController();let temporary;
  await assert.rejects(()=>resolveInputs({indexJson:p},event=>{
    if(event.temporary)temporary=event.temporary;
    if(event.phase==='Reading ZIP')controller.abort();
  },{signal:controller.signal}), {name:'AbortError'});
  assert(temporary);assert(!fs.existsSync(temporary));
});

test('explicit source ZIP takes precedence over original data inside a converted bundle', async t => {
  const original=[{id:'selected-source',mapping:{}}], bundled=[{id:'other-source',mapping:{}}];
  const source=file(t,[['conversations.json',JSON.stringify(original)],['chat.html','var jsonData = '+JSON.stringify(original)+';</html>']]);
  const bundle=file(t,[['conversations.json',JSON.stringify(bundled)],['chat.html','var jsonData = '+JSON.stringify(bundled)+';</html>'],['conversations-index.json',JSON.stringify(original)],['chat-index.html','var jsonData = '+JSON.stringify(original)+';</html>']]);
  const result=await resolveInputs({original:source,indexJson:bundle});t.after(()=>result.cleanup());
  assert.equal(result.byRole.original.length,1);assert.equal(result.byRole.originalHtml.length,1);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.byRole.original[0].file,'utf8')),original);
  assert.equal(result.byRole.indexJson.length,1);assert.equal(result.byRole.indexHtml.length,1);
  const inspected=await audit({original:source,indexJson:bundle});
  assert(!inspected.report.findings.some(x=>['DUPLICATE_ID','MISSING_CONVERSATION','ADDED_CONVERSATION'].includes(x.rule)));
});
test('a ZIP selected as source and bundle is read once and supplies each role once', async t => {
  const p=file(t,[['conversations.json','[]'],['conversations-index.json','[]'],['chat-index.html','var jsonData = [];</html>']]);
  const result=await resolveInputs({original:p,indexJson:p,indexHtml:p});t.after(()=>result.cleanup());
  assert.equal(result.descriptors.length,3);assert.equal(result.byRole.original.length,1);assert.equal(result.byRole.indexHtml.length,1);
});
test('explicit converted files override converted data inside a source ZIP', async t => {
  const source=file(t,[['conversations.json','[]'],['conversations-index.json','[]'],['chat-index.html','var jsonData = [];</html>']]);
  const selected=path.join(path.dirname(source),'selected.json');fs.writeFileSync(selected,'[]');
  const result=await resolveInputs({original:source,indexJson:selected});t.after(()=>result.cleanup());
  // Windows temporary directories can use a short-name alias; selection is
  // compared against the canonical file that the input resolver actually opens.
  assert.equal(result.byRole.indexJson.length,1);assert.equal(result.byRole.indexJson[0].file,fs.realpathSync(selected));assert.equal(result.byRole.indexHtml,undefined);
});
