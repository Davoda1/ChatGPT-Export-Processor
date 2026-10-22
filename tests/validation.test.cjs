'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {audit,evidence,profiles}=require('../src/core/audit.cjs');const {readRecords,duplicateKeys,hash}=require('../src/core/reader.cjs');
const {collectSchema,compareSchema}=require('../src/core/schema.cjs');const reference=require('../src/vendor/reference-1.1.0.cjs');
const {publicReport,toHtml,toCsv}=require('../src/core/report.cjs');
const c=(text='Hello',id='c')=>({id,title:'A test',current_node:'a',mapping:{u:{parent:null,children:['a'],message:{id:'u',author:{role:'user'},content:{content_type:'text',parts:['A question']},metadata:{}}},a:{parent:'u',children:[],message:{id:'a',author:{role:'assistant'},content:{content_type:'text',parts:[text]},metadata:{}}}}});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'export-processor-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return(name,data)=>{const file=path.join(dir,name);fs.writeFileSync(file,typeof data==='string'||Buffer.isBuffer(data)?data:JSON.stringify(data));return file;};}
async function run(t,original,converted,extra={}){const save=fixture(t);return audit({original:save('original.json',original),indexJson:save('index.json',converted),...extra});}
const rules=r=>r.report.findings.map(x=>x.rule);
test('strict reader accepts UTF-8, escaped braces, chunk boundaries and byte pointers',async t=>{const save=fixture(t),data=[c('😀 { } " \\ '+ 'a'.repeat(1100000)),c('tail','c2')];const file=save('large.json',data),got=[];for await(const r of readRecords(file))got.push(r.value);assert.deepEqual(got,data);});
for(const [name,text]of [['missing comma','[{"id":"a"}{"id":"b"}]'],['trailing comma','[{},]'],['trailing data','[{}] false'],['incomplete','[{"id":"a"}'],['not array','{"x":[]}'],['scalar entry','[1]'],['broken string','[{"x":"hi}]']])test('strict parser rejects '+name,async t=>{const save=fixture(t);await assert.rejects(async()=>{for await(const r of readRecords(save('bad.json',text)))void r;});});
test('invalid UTF-8 is rejected',async t=>{const save=fixture(t);await assert.rejects(async()=>{for await(const r of readRecords(save('bad.json',Buffer.from([91,123,34,120,34,58,34,255,34,125,93]))))void r;});});
test('numbers that JavaScript would round to an unsafe integer are rejected',async t=>{const save=fixture(t);for(const number of ['9007199254740993','1e400'])await assert.rejects(async()=>{for await(const r of readRecords(save('number.json','[{"n":'+number+'}]')))void r;},/Numeric value/);});
test('duplicate key scanner does not confuse string content with keys',()=>{assert.equal(duplicateKeys('{"a":1,"a":2,"nested":{"a":3},"s":"\\\"a\\\":4"}').length,1);});
test('unchanged text and all branches agree with original',async t=>{const a=c();a.mapping.b={parent:'u',children:[],message:{author:{role:'assistant'},content:{parts:['Inactive branch']}}};a.mapping.u.children.push('b');const r=await run(t,[a],[structuredClone(a)]);assert(!rules(r).includes('REFERENCE_MISMATCH'));assert.equal(r.report.counts.messages,3);});
test('user content and inactive branch alterations are identified with exact pointers',async t=>{const a=c(),b=structuredClone(a);b.mapping.u.message.content.parts[0]='Changed';b.mapping.a.message.content.parts[0]='Changed answer';const r=await run(t,[a],[b]);assert(rules(r).includes('USER_CONTENT'));assert(rules(r).includes('REFERENCE_MISMATCH'));assert(r.report.findings.some(f=>f.pointer==='/mapping/u/message/content'));});
test('missing and added conversations are confirmed issues',async t=>{const r=await run(t,[c('a','1'),c('b','2')],[c('a','1'),c('c','3')]);assert(rules(r).includes('MISSING_CONVERSATION'));assert(rules(r).includes('ADDED_CONVERSATION'));});
test('duplicate conversation IDs fail',async t=>{const r=await run(t,[c()],[c(),c()]);assert(rules(r).includes('DUPLICATE_ID'));});
test('node parent cycle is reported, never loops',async t=>{const a=c();a.mapping.u.parent='a';a.mapping.a.children=['u'];const r=await run(t,[a],[a]);assert(rules(r).includes('BRANCH'));});
test('JSON/HTML divergence is detected independently from source',async t=>{const save=fixture(t),a=c('A'),b=c('B');const r=await audit({indexJson:save('x.json',[a]),indexHtml:save('x.html','<script>const jsonData = '+JSON.stringify([b])+';</script></html>')});assert(rules(r).includes('PAIR_MISMATCH'));assert(r.report.checks.some(c=>c.name==='Source comparison'&&c.status==='NOT CHECKED'));});
test('HTML scripts are never evaluated',async t=>{const save=fixture(t);globalThis.processorExecuted=false;await audit({indexHtml:save('x.html','<script>globalThis.processorExecuted=true; const jsonData = '+JSON.stringify([c()])+';</script></html>')});assert.equal(globalThis.processorExecuted,false);});
test('source hash and bytes stay unchanged after audit',async t=>{const save=fixture(t),file=save('x.json',[c()]);const before=fs.readFileSync(file);await audit({original:file,indexJson:file});assert.equal(hash(fs.readFileSync(file)),hash(before));});
test('new source widgets are detected even when reference output is identical',async t=>{const a=c('\ue200genui\ue202{"future_widget":{"x":1}}\ue201'),b=structuredClone(a);reference.transformObj(b,profiles[7].set);const r=await run(t,[a],[b]);assert(rules(r).includes('NEW_WIDGET'));assert(!rules(r).includes('REFERENCE_MISMATCH'));});
test('future role and content fields remain reviewable',()=>{const a=c();a.mapping.a.message.author.role='future_agent';a.mapping.a.message.content.future_field={x:1};const inv={};collectSchema(a,inv,{});const changes=compareSchema(inv,{});assert(changes.some(x=>x.key==='role:future_agent'));assert(changes.some(x=>x.key==='content.future_field'));});
test('schema marker parser never captures text across malformed examples',()=>{const a=c('\ue200cite...\nPRIVATE TEXT\n\ue200entity\ue202["x","Name"]\ue201'),inv={};collectSchema(a,inv,{});assert(!Object.keys(inv).some(x=>x.includes('PRIVATE')));assert(Object.keys(inv).includes('marker:entity'));});
test('schema handles novel non-array reference metadata without throwing',()=>{const a=c();a.mapping.a.message.metadata.content_references={unexpected:true};const inv={};collectSchema(a,inv,{});assert(inv['metadata.content_references'].types.object);});
test('literal user markers are preserved and not reported as conversion artifacts',async t=>{const a=c();a.mapping.u.message.content.parts=['\ue200future_marker\ue202x\ue201'];const r=await run(t,[a],[a]);assert(!rules(r).includes('MARKER'));assert(!rules(r).includes('NEW_MARKER'));});
test('code examples do not trigger unsafe-markup heuristics',async t=>{const a=c('```html\n<script>alert(1)</script>\n```');const r=await run(t,[a],[a]);assert(!rules(r).includes('UNSAFE_RENDER'));});
test('unsafe link in prose, empty destination, and object artifact are review candidates',async t=>{const a=c('[Bad](javascript:alert(1)) [Empty]() [object Object]');const r=await run(t,[a],[a]);for(const x of ['UNSAFE_RENDER','EMPTY_LINK','ARTIFACT'])assert(rules(r).includes(x));});
test('auto writing detection selects one profile across all conversations',async t=>{const a=c(':::writing{variant="document" title="Memo"}\nHello\n:::'),b=structuredClone(a);reference.transformObj(b,profiles[2].set);const r=await run(t,[a],[b]);assert(!rules(r).includes('REFERENCE_MISMATCH'));assert(r.report.profileCandidates.filter(x=>!x.mismatchedConversations).length>0);});
test('mixed profile outputs cannot pass by per-conversation switching',async t=>{const a=c(':::writing{variant="document" title="Memo"}\nHello\n:::','1'),b={...structuredClone(a),id:'2'},out=[structuredClone(a),structuredClone(b)];reference.transformObj(out[0],profiles[2].set);const r=await run(t,[a,b],out);assert(rules(r).includes('REFERENCE_MISMATCH'));});
test('independent chart expectation retains zero, units and all rows',()=>{const a=c('\ue200genui\ue202'+JSON.stringify({chart:{content:{meta:{title:'Saved values'},xKey:'x',series:[{dataKey:'y',label:'Score',valueSuffix:'%'}],data:[{x:'A',y:0},{x:'B',y:-2.5}]}}})+'\ue201');reference.transformObj(a,profiles[7].set);const text=a.mapping.a.message.content.parts[0];assert.match(text,/\| A \| 0% \|/);assert.match(text,/\| B \| -2\.5% \|/);assert.match(text,/Saved values/);});
test('citation matching is message-local and unsafe recorded URLs are rejected',()=>{const a=c('\ue200genui\ue202{"citation":{"ref":"turn0view0"}}\ue201');a.mapping.a.message.metadata.content_references=[{type:'grouped_webpages',prefix:'genui',items:[{refs:[{turn_index:0,ref_type:'view',ref_index:0}],title:'Source',url:'javascript:alert(1)'}]}];reference.transformObj(a,profiles[7].set);assert(!a.mapping.a.message.content.parts[0].includes('javascript'));});
test('evidence returns actual and expected strings without input mutation',async t=>{const save=fixture(t),a=c('One'),b=c('Two');const r=await audit({original:save('a.json',[a]),indexJson:save('b.json',[b])},{keepInputs:true});t.after(()=>r.inputs.cleanup());const f=r.report.findings.find(x=>x.rule==='REFERENCE_MISMATCH');const e=await evidence(r,f.id);assert.equal(e.actual,'Two');assert.equal(e.expected,'One');assert.equal(e.source,'One');});
test('reports escape HTML, suppress paths and guard CSV formulas',()=>{const r={status:'REVIEW',conclusion:'<script>bad</script>',createdAt:'now',ruleVersion:'1',profile:'all',files:[{name:'x',path:'/private/file',sha256:'a'}],protectedFiles:['/private/file'],checks:[],counts:{total:1},findings:[{severity:'info',rule:'X',title:'=CMD()',message:'<img onerror=x>',pointer:'/'}],schema:{},limitations:[]};assert(!JSON.stringify(publicReport(r)).includes('/private/file'));assert(!toHtml(r).includes('<script>bad'));assert(toHtml(r).includes('&lt;script&gt;'));assert(toCsv(r).includes("'=CMD()"));});
test('valid converted-only inspection never claims full source validation',async t=>{const save=fixture(t),r=await audit({indexJson:save('index.json',[c()])});assert.notEqual(r.report.status,'PASS');assert(r.report.checks.some(x=>x.name==='Source comparison'&&x.status==='NOT CHECKED'));});

test('negative zero and numeric underflow cannot be silently normalized', async t => {
  const save=fixture(t);
  for(const number of ['-0','-0.0','1e-400','-1e-400']) await assert.rejects(async()=>{
    for await(const rec of readRecords(save('number.json','[{"n":'+number+'}]')))void rec;
  },/Numeric value/);
  const valid=[];for await(const rec of readRecords(save('zero.json','[{"n":0e-100}]')))valid.push(rec.value);
  assert.equal(valid[0].n,0);
});
test('explicit profile aliases and option objects select one profile', async t => {
  const {profileIndex}=require('../src/core/audit.cjs');
  assert.equal(profileIndex('auto'),null);assert.equal(profileIndex('all'),7);assert.equal(profileIndex('email'),0);
  assert.equal(profileIndex({standard:true,document:false,chatMessage:true}),5);
  for(const x of ['invalid',8,-1,[],true])assert.throws(()=>profileIndex(x),/Invalid/);
  const a=c(':::writing{variant="document" title="Memo"}\nBody\n:::'),b=structuredClone(a);
  reference.transformObj(b,profiles[2].set);
  const r=await run(t,[a],[b],{profile:{document:true}});
  assert.equal(r.report.profileIndex,2);assert(!rules(r).includes('REFERENCE_MISMATCH'));
});
test('multiple matching profiles are visible instead of pretending unique detection', async t => {
  const r=await run(t,[c()],[c()]);
  assert.equal(r.report.profileAmbiguous,true);
  assert.equal(r.report.profileCandidates.filter(x=>x.mismatchedConversations===0).length,8);
});
test('empty malformed converted data remains Failed rather than being overwritten by Limited', async t => {
  const save=fixture(t),r=await audit({indexJson:save('invalid.json','not json')});
  assert.equal(r.report.status,'FAIL');assert.equal(r.report.statusLabel,'Failed');
});
test('empty valid data is Limited and never certifies conversations', async t => {
  const save=fixture(t),file=save('empty.json',[]),r=await audit({original:file,indexJson:file});
  assert.equal(r.report.status,'LIMITED');assert.equal(r.report.coverage.complete,false);
});
test('coverage explicitly identifies absent comparison inputs', async t => {
  const save=fixture(t),r=await audit({indexJson:save('index.json',[c()])});
  assert.deepEqual(r.report.coverage.missing,['original','indexHtml']);
  assert.equal(r.report.coverage.hasOriginal,false);assert.equal(r.report.coverage.complete,false);
});
test('changed source or target record cannot be shown as stale evidence', async t => {
  const save=fixture(t),a=c('One'),b=c('Two'),target=save('b.json',[b]);
  const r=await audit({original:save('a.json',[a]),indexJson:target},{keepInputs:true});t.after(()=>r.inputs.cleanup());
  const f=r.report.findings.find(x=>x.rule==='REFERENCE_MISMATCH');
  fs.writeFileSync(target,JSON.stringify([c('New')]));
  await assert.rejects(()=>evidence(r,f.id),/Input changed/);
});
test('audit cancellation propagates and removes temporary inputs', async t => {
  const save=fixture(t),controller=new AbortController();let temp;
  await assert.rejects(()=>audit({indexJson:save('index.json',[c()])},{signal:controller.signal,progress:event=>{
    if(event.temporary)temp=event.temporary;
    if(event.phase?.startsWith('Inspecting'))controller.abort();
  }}),{name:'AbortError'});
  assert(temp);assert(!fs.existsSync(temp));
});
test('CSV formulas with leading control whitespace are neutralized',()=>{
  const {csvCell}=require('../src/core/report.cjs');
  for(const cell of ['=1+1',' \t=CMD()','\r\n@SUM(1)','\t-1','+SUM(A1)'])assert(csvCell(cell).startsWith('"\''));
  assert.equal(csvCell('ordinary text'),'"ordinary text"');
});
test('public reports redact known input paths embedded in diagnostic text',()=>{
  const r={files:[{name:'file.json',path:'/private/session/file.json',error:'Read failed: /private/session/file.json'}],protectedFiles:['/private/session/file.json'],findings:[{message:'Cannot read /private/session/file.json',actual:'raw content'}]};
  const publicCopy=publicReport(r);assert(!JSON.stringify(publicCopy).includes('/private/session'));
  assert.equal(publicCopy.findings[0].actual,undefined);assert.equal(r.findings[0].actual,'raw content');
});

test('complete matching inputs with the public viewer shell pass exact checks', async t => {
  const save=fixture(t),a=c(),{prefix,suffix}=require('../src/viewer/shell.cjs').getShell();
  const file=save('original.json',[a]);
  const r=await audit({original:file,indexJson:save('conversations-index.json',[a]),indexHtml:save('chat-index.html',prefix+JSON.stringify([a])+suffix)});
  assert.equal(r.report.status,'PASS',JSON.stringify(r.report.findings));
  assert.equal(r.report.coverage.complete,true);
  assert.equal(r.report.checks.find(x=>x.name==='HTML shell').status,'PASS');
});
test('changed public viewer script shell is detected even with unchanged data', async t => {
  const save=fixture(t),a=c(),{prefix,suffix}=require('../src/viewer/shell.cjs').getShell();
  const r=await audit({original:save('original.json',[a]),indexJson:save('index.json',[a]),indexHtml:save('changed.html',prefix+JSON.stringify([a])+suffix+'<!-- modification -->')});
  assert.equal(r.report.checks.find(x=>x.name==='HTML shell').status,'REVIEW');
  assert(rules(r).includes('HTML_SHELL'));
});
test('preserved original HTML divergence remains visible despite matching converted outputs', async t => {
  const save=fixture(t),a=c('JSON source'),b=c('HTML source'),{prefix,suffix}=require('../src/viewer/shell.cjs').getShell();
  const r=await audit({original:save('original.json',[a]),originalHtml:save('chat.html','<script>var jsonData = '+JSON.stringify([b])+';</script></html>'),indexJson:save('index.json',[a]),indexHtml:save('index.html',prefix+JSON.stringify([a])+suffix)});
  assert(rules(r).includes('SOURCE_PAIR'));assert.equal(r.report.status,'REVIEW');
});

test('large evidence panes are bounded at a UTF-8 boundary with an explicit marker', async t => {
  const save=fixture(t),source=save('original.json',[c('Source')]),actual=save('actual.json',[c('😀'.repeat(300000))]);
  const r=await audit({original:source,indexJson:actual},{keepInputs:true});t.after(()=>r.inputs.cleanup());
  const f=r.report.findings.find(x=>x.rule==='REFERENCE_MISMATCH');const value=await evidence(r,f.id);
  assert.equal(value.truncated.actual,true);assert.equal(value.truncated.source,false);
  assert.equal(value.previewLimitBytes,1024*1024);assert(value.originalBytes.actual>value.previewLimitBytes);
  assert.match(value.actual,/\[Preview truncated at 1 MiB/);assert(!value.actual.includes('\ufffd'));
  assert(Buffer.byteLength(value.actual)<value.previewLimitBytes+150);
});
test('a retained-finding limit cannot turn incomplete evidence into Passed', async t => {
  const save=fixture(t),records=Array.from({length:110},(_,i)=>c('```text\nUnclosed example',String(i)));
  const {prefix,suffix}=require('../src/viewer/shell.cjs').getShell();
  const r=await audit({original:save('original.json',records),indexJson:save('index.json',records),indexHtml:save('index.html',prefix+JSON.stringify(records)+suffix),maxFindings:100});
  assert.equal(r.report.findings.length,100);assert(r.report.counts.total>100);
  assert.equal(r.report.status,'LIMITED');assert.equal(r.report.coverage.retainedAll,false);assert.equal(r.report.coverage.complete,false);
  assert.equal(r.report.checks.find(x=>x.name==='Finding retention').status,'INCOMPLETE');
});
