'use strict';
const fs=require('node:fs'),path=require('node:path');
const {isDeepStrictEqual:equal}=require('node:util');
const {readRecords,readPointer,hash,canonical}=require('./reader.cjs');
const {resolveInputs,digest,checkAbort}=require('./inputs.cjs');
const {collectSchema,compareSchema,signature}=require('./schema.cjs');
const reference=require('../vendor/reference-1.1.0.cjs'),shell=require('../vendor/html-shell.json');
const escPointer=s=>String(s).replace(/~/g,'~0').replace(/\//g,'~1');
const profiles=Array.from({length:8},(_,i)=>({name:i===7?'All writing blocks':i===0?'Email only':['Email',i&1?'Standard':'',i&2?'Document':'',i&4?'Chat message':''].filter(Boolean).join(' + '),set:new Set(['email',...(i&1?['standard']:[]),...(i&2?['document']:[]),...(i&4?['chat_message']:[])])}));
const knownMarkers=new Set(['cite','citation','entity','product','products','navlist','image_group','carousel','i','finance','weather','sports','video','youtube','file','filenavlist','filecite','genui','url','visualize','map','audio','turn','forecast','schedule','standing','ref','link','link_title','product_entity','businesses_map','entity_metadata','imagegroup','image','images','memcite']);
const KNOWN_GENUI=new Set(['citation','refs','chart','charts_widget_v2','suggest_automation','map_widget','image_group','image_query','image','images','finance','weather','sports','product','products','carousel','video']);
const stableId=c=>typeof c.id==='string'&&c.id?c.id:typeof c.conversation_id==='string'?c.conversation_id:'';
const get=(o,p)=>p.split('/').slice(1).reduce((v,k)=>{k=k.replace(/~1/g,'/').replace(/~0/g,'~');return v!=null&&Object.hasOwn(Object(v),k)?v[k]:undefined;},o);
function diff(a,b,p='',out=[],limit=40){
  if(equal(a,b)||out.length>=limit)return out;
  if(a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)){
    for(const k of new Set([...Object.keys(a),...Object.keys(b)])){diff(a[k],b[k],p+'/'+escPointer(k),out,limit);if(out.length>=limit)break;}
  }else out.push({pointer:p||'/',expected:a,actual:b});return out;
}
function stripCode(s){
  const {lexer}=require('marked');
  function visible(t){
    if(!t||t.type==='code'||t.type==='codespan')return '';
    if(t.type==='link'||t.type==='image')return t.raw||'';
    if(Array.isArray(t.tokens))return t.tokens.map(visible).join('');
    if(Array.isArray(t.items))return t.items.map(visible).join('\n');
    if(t.type==='table')return [...t.header,...t.rows.flat()].map(visible).join(' ');
    return t.text||t.raw||'';
  }
  return lexer(s).map(visible).join('\n');
}
function inspectGraph(c,context,add){
  if(!c.mapping||typeof c.mapping!=='object'||Array.isArray(c.mapping)){add('error','STRUCTURE','Conversation mapping is missing or is not an object.',context,'/mapping');return;}
  const mapping=c.mapping;
  if(c.current_node!=null&&!Object.hasOwn(mapping,c.current_node))add('warning','BRANCH','current_node does not identify a saved node.',context,'/current_node');
  const done=new Set();
  for(const [id,n]of Object.entries(mapping)){
    const p='/mapping/'+escPointer(id);
    if(!n||typeof n!=='object'||Array.isArray(n)){add('error','STRUCTURE','Invalid mapping node.',context,p);continue;}
    if(n.parent!=null&&!Object.hasOwn(mapping,n.parent))add('warning','BRANCH','Node refers to a missing parent.',context,p+'/parent');
    if(Array.isArray(n.children))for(const child of n.children){if(!Object.hasOwn(mapping,child))add('warning','BRANCH','Child reference is missing from the mapping.',context,p+'/children');else if(mapping[child]?.parent!==id)add('warning','BRANCH','Child and parent references disagree.',context,p+'/children');}
    const chain=new Set();let k=id;while(k!=null&&mapping[k]&&!done.has(k)){
      if(chain.has(k)){add('error','BRANCH','Cycle in conversation ancestry.',context,p);break;}chain.add(k);k=mapping[k].parent;
    }for(const k of chain)done.add(k);
  }
}
function scanContent(c,ctx,add,counts){
  for(const [id,n]of Object.entries(c.mapping||{})){
    const m=n?.message;if(!m)continue;counts.messages++;
    if(m.author?.role==='user'){counts.userMessages++;continue;}
    const parts=m.content?.parts;if(!Array.isArray(parts))continue;
    for(let i=0;i<parts.length;i++){
      const text=parts[i];if(typeof text!=='string')continue;
      const p='/mapping/'+escPointer(id)+'/message/content/parts/'+i;
      const context={...ctx,nodeId:id};const visible=stripCode(text);
      if(/[\ue200-\ue206]/.test(visible))add('warning','MARKER','Private-use display markers remain outside a code example.',context,p);
      if(/\[object Object\]/.test(visible))add('warning','ARTIFACT','Possible object-to-text serialization artifact. Review in context.',context,p);
      if(/\[[^\]\n]+\]\(\s*\)/.test(visible))add('warning','EMPTY_LINK','An empty Markdown destination may render as a broken link.',context,p);
      if(/\]\(\s*(?:javascript|vbscript|data|file):/i.test(visible)||/<(?:script|iframe|object)\b|<[^>\n]*\bon\w+\s*=/i.test(visible))add('warning','UNSAFE_RENDER','Active markup or an unsafe URL appears outside a code example. Preview blocks it.',context,p);
      if(/\bturn\d+(?:search|view|fetch|product|image|business)\d+\b/.test(visible))add('info','INTERNAL_REF','A raw reference ID remains. It may be literal prose; review its source.',context,p);
      if(/"(?:render_as|charts_widget_v2|suggest_automation|map_widget)"\s*:/.test(visible))add('warning','WIDGET_PAYLOAD','Possible widget payload is exposed as prose.',context,p);
      if(text.includes('\ufffd'))add('info','UNICODE','Replacement character U+FFFD appears in content; it may already exist in the source.',context,p);
      const fences=[...text.matchAll(/^\s{0,3}(`{3,}|~{3,})([^\n]*)$/gm)];let open=null;
      for(const f of fences){if(!open)open=f[1];else if(f[1][0]===open[0]&&f[1].length>=open.length&&!f[2].trim())open=null;}
      if(open)add('info','MARKDOWN','Unclosed fenced code block. Some viewers intentionally accept this.',context,p);
    }
  }
}
function unknownSource(c,ctx,add){
  for(const [id,n]of Object.entries(c.mapping||{})){
    const m=n?.message;if(!m||m.author?.role==='user')continue;
    for(const [i,s]of (Array.isArray(m.content?.parts)?m.content.parts:[]).entries())if(typeof s==='string'){
      const pointer='/mapping/'+escPointer(id)+'/message/content/parts/'+i;
      for(const x of s.matchAll(/\ue200([a-z][a-z0-9_]{0,79})(?:\ue202([^\ue200\ue201]*))?\ue201/gi)){
        if(!knownMarkers.has(x[1]))add('warning','NEW_MARKER','Unrecognized source marker: '+x[1],{...ctx,nodeId:id},pointer);
        if(x[1]==='genui'){try{const p=JSON.parse(x[2]);if(p&&typeof p==='object'&&!Array.isArray(p))for(const k of Object.keys(p))if(!KNOWN_GENUI.has(k))add('warning','NEW_WIDGET','Unrecognized genui payload key: '+k,{...ctx,nodeId:id},pointer);}catch{/* opaque widget references are inventoried separately */}}
      }
    }
  }
}

function profileIndex(value) {
  if (value == null || value === 'auto') return null;
  if (value === 'all') return 7;
  if (value === 'email') return 0;
  if (typeof value === 'object' && !Array.isArray(value)) return (value.standard?1:0)|(value.document?2:0)|(value.chatMessage?4:0);
  if ((typeof value === 'number' || /^[0-7]$/.test(value)) && Number.isInteger(Number(value)) && Number(value)>=0 && Number(value)<=7) return Number(value);
  throw new Error('Invalid writing profile.');
}
function knownShell(meta) {
  if (meta.prefixSha256 === shell.prefixSha256 && meta.suffixSha256 === shell.suffixSha256) return 'legacy 1.1.0';
  // Only shell bytes are shared. Expected conversation transformations always use the independent reference above.
  try {const {prefix,suffix}=require('../viewer/shell.cjs').getShell();if(typeof prefix==='string'&&typeof suffix==='string'&&meta.prefixSha256===hash(prefix)&&meta.suffixSha256===hash(suffix))return 'public 1.0.0';} catch { /* The standalone validator also works without a converter. */ }
  return null;
}
async function audit(spec,{progress=()=>{},keepInputs=false,signal}={}){
  checkAbort(signal);
  const requestedProfile=profileIndex(spec.profile);
  const start=Date.now();let inputs;
  const r={application:'ChatGPT Export Processor',version:require('../../package.json').version,ruleVersion:'Legacy conversion rules 1.1.0 / independent checks 1.0.0',createdAt:new Date().toISOString(),status:'INCOMPLETE',conclusion:'',profile:'Not checked',files:[],checks:[],findings:[],counts:{errors:0,warnings:0,info:0,total:0,conversations:0,messages:0,userMessages:0},schema:{inventory:{},changes:[],signature:''},limitations:[
    'Reference agreement demonstrates compatibility with the retained conversion rules; it cannot prove those rules are perfect.',
    'Automatic checks cannot establish factual accuracy, pixel-perfect rendering in every viewer, or completeness of media not present in the export.',
    'No network requests or imported script execution. Remote links and assets are not fetched. Safe preview is a separate renderer.',
    'Heuristic findings are review candidates. Literal examples, existing source defects and intentional partial Markdown can trigger them.',
    'Schema checks cover conversation/node/message/author/content/metadata/reference fields, known discriminators and display markers. Arbitrary nested metadata semantics are not fully modeled.'
  ]};
  const contexts=new Map(),limit=Math.max(100,Math.min(100000,Number(spec.maxFindings)||10000));
  let next=1;const add=(severity,rule,message,ctx={},pointer='/',extra={})=>{
    r.counts.total++;r.counts[severity==='error'?'errors':severity==='warning'?'warnings':'info']++;
    if(r.findings.length>=limit)return;
    const id=String(next++).padStart(5,'0');r.findings.push({id,severity,rule,message,file:ctx.file||'',title:ctx.title||'',conversationId:ctx.id||'',nodeId:ctx.nodeId||'',pointer,...extra});contexts.set(id,ctx);
  };
  const check=(name,status,detail)=>r.checks.push({name,status,detail});
  const maps={original:new Map(),indexJson:new Map(),indexHtml:new Map(),originalHtml:new Map()};
  const profileResults=profiles.map(()=>({mismatches:0,details:[]}));let sourcePairs=0,userChecks=0,userChanges=0;
  const inventory={};
  try{
    inputs=await resolveInputs(spec,progress,{signal});
    r.protectedFiles=inputs.protectedFiles;
    for(const role of ['original','originalHtml','indexJson','indexHtml']){
      for(const d of inputs.byRole[role]||[]){
        checkAbort(signal);
        const before=await fs.promises.stat(d.file),meta={}, map=maps[role];let n=0;
        const info={name:d.label,role,bytes:before.size,path:d.file,records:0,sha256:null};r.files.push(info);
        progress({phase:'Inspecting '+role,detail:d.label,ratio:0});
        try{
          for await(const rec of readRecords(d.file,meta,bytes=>progress({phase:'Inspecting '+role,detail:d.label,ratio:Math.min(1,bytes/before.size)}),{signal})){
            checkAbort(signal);
            const c=rec.value,id=stableId(c)||'@ordinal:'+map.size;
            const ctx={id,title:String(c.title||'(Untitled)'),file:d.label,role,target:rec.pointer};
            if(!stableId(c))add('warning','IDENTITY','Conversation has no stable ID; ordinal fallback limits matching.',ctx,'/id');
            if(map.has(id)){add('error','DUPLICATE_ID','Duplicate conversation identity. Matching is ambiguous.',ctx,'/id');n++;continue;}
            for(const x of rec.duplicates)add('error','DUPLICATE_KEY','Duplicate JSON key: '+x.key+' at character '+x.characterOffset,ctx,'/');
            map.set(id,{pointer:rec.pointer,ordinal:map.size,digest:hash(canonical(c)),title:ctx.title});
            if(role==='original'||(!inputs.byRole.original&&role===(inputs.byRole.indexJson?'indexJson':'indexHtml')))collectSchema(c,inventory,{conversationId:id,title:ctx.title,file:d.label});
            if(role==='original')unknownSource(c,ctx,add);
            if(role==='indexJson'||role==='indexHtml'){
              // Scanning one converted dataset avoids double counting identical outputs.
              if(role===(inputs.byRole.indexJson?'indexJson':'indexHtml')){inspectGraph(c,ctx,add);const sourceForScan=maps.original.get(id);const scanOriginal=sourceForScan?await readPointer(sourceForScan.pointer):null;scanContent(c,ctx,(severity,rule,message,context,pointer)=>{const inherited=scanOriginal&&equal(get(scanOriginal,pointer),get(c,pointer));add(severity,rule,message+(inherited?' The same content is present in the original.':''),context,pointer,{origin:inherited?'pre-existing in source':scanOriginal?'changed content':'source unavailable'});},r.counts);r.counts.conversations++;}
              const source=maps.original.get(id);
              if(source){
                ctx.source=source.pointer;sourcePairs++;
                if(source.ordinal!==map.get(id).ordinal)add('warning','ORDER','Conversation order differs from the original.',ctx,'/id');
                const original=await readPointer(source.pointer);
                for(const [nodeId,node]of Object.entries(original.mapping||{}))if(node?.message?.author?.role==='user'){
                  userChecks++;const p='/mapping/'+escPointer(nodeId)+'/message/content';
                  if(!equal(node.message.content,c.mapping?.[nodeId]?.message?.content)){userChanges++;add('error','USER_CONTENT','User content differs from the original.',{...ctx,nodeId},p);}
                }
                for(let pi=0;pi<profiles.length;pi++){
                  const expected=structuredClone(original);reference.transformObj(expected,profiles[pi].set);
                  if(!equal(expected,c)){
                    profileResults[pi].mismatches++;
                    if(profileResults[pi].details.length<limit){for(const x of diff(expected,c,'',[],12))profileResults[pi].details.push({ctx,pointer:x.pointer});}
                  }
                }
              }else if(inputs.byRole.original)add('error','ADDED_CONVERSATION','Converted conversation does not exist in the original input.',ctx,'/id');
            }
            n++;
          }
          const after=await fs.promises.stat(d.file);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)add('error','INPUT_CHANGED','Input changed during inspection.',{file:d.label});
          Object.assign(info,{records:meta.records,sha256:meta.sha256});
          if(role==='indexHtml'){
            const exact=knownShell(meta);
            check('HTML shell',exact?'PASS':'REVIEW',exact?'Matches the '+exact+' viewer shell.':'HTML shell differs or uses an unfamiliar wrapper. Its scripts were not executed.');
            if(!exact)add('warning','HTML_SHELL','Viewer shell is unfamiliar; embedded data is checked separately.',{file:d.label});
            if(!exact&&meta.htmlClosings!==1)add('warning','HTML_ENDING','Expected one closing HTML document; found '+meta.htmlClosings+'.',{file:d.label});
          }
          check(d.label+' syntax','PASS',`${n} conversation objects parsed; UTF-8 and JSON syntax checked.`);
        }catch(e){if(e.name==='AbortError'||signal?.aborted)throw e;add('error','PARSE',e.message,{file:d.label});check(d.label+' syntax','FAIL','Parsing stopped. Later records were not inspected.');info.error=e.message;info.sha256=await digest(d.file,{signal});}
      }
    }
    const mainRole=inputs.byRole.indexJson?'indexJson':'indexHtml';
    for(const id of maps.original.keys())for(const role of ['indexJson','indexHtml'])if(inputs.byRole[role]&&!maps[role].has(id))add('error','MISSING_CONVERSATION','Original conversation is absent from '+role+'.',{id,title:maps.original.get(id).title,file:inputs.byRole[role][0].label,source:maps.original.get(id).pointer});
    if(inputs.byRole.original){
      const selected=requestedProfile==null?profileResults.reduce((best,x,i)=>x.mismatches<profileResults[best].mismatches?i:best,7):requestedProfile;
      if(!profiles[selected])throw new Error('Invalid writing profile.');
      r.profile=profiles[selected].name;r.profileIndex=selected;r.profileCandidates=profileResults.map((p,i)=>({index:i,name:profiles[i].name,mismatchedConversations:p.mismatches}));
      r.profileAmbiguous=requestedProfile==null&&sourcePairs>0&&profileResults.filter(p=>p.mismatches===0).length>1;
      if(r.profileAmbiguous)check('Profile detection','PASS','Several profiles produce the same supplied output. The selected profile applies across the entire inspection.');
      for(const d of profileResults[selected].details)add('error','REFERENCE_MISMATCH','Converted value differs from the selected reference conversion rules.',d.ctx,d.pointer);
      check('Source comparison',r.files.some(f=>f.error)?'INCOMPLETE':sourcePairs?(profileResults[selected].mismatches?'FAIL':'PASS'):'NOT CHECKED',`${sourcePairs} source/output conversation pairs; ${profileResults[selected].mismatches} mismatched pairs using ${r.profile}.`);
      check('User content',userChanges?'FAIL':r.files.some(f=>f.error)?'INCOMPLETE':userChecks?'PASS':'NOT CHECKED',`${userChecks} user-content subtrees checked across supplied outputs; ${userChanges} changes.`);
    }else {check('Source comparison','NOT CHECKED','No original input. Conversion accuracy and preservation cannot be established.');check('User content','NOT CHECKED','An original export is required.');}
    if(inputs.byRole.indexJson&&inputs.byRole.indexHtml){
      let mismatches=0;
      for(const id of new Set([...maps.indexJson.keys(),...maps.indexHtml.keys()])){
        const a=maps.indexJson.get(id),b=maps.indexHtml.get(id);
        if(!a||!b||a.digest!==b.digest){mismatches++;add('error','PAIR_MISMATCH','JSON and HTML conversation data disagree.',{id,title:a?.title||b?.title,file:inputs.byRole.indexHtml[0].label,target:b?.pointer,other:a?.pointer});}
        else if(a.ordinal!==b.ordinal)add('warning','ORDER','Conversation order differs between JSON and HTML.',{id,title:a.title,file:inputs.byRole.indexHtml[0].label});
      }
      check('JSON / HTML agreement',r.files.some(f=>['indexJson','indexHtml'].includes(f.role)&&f.error)?'INCOMPLETE':mismatches?'FAIL':'PASS',`${maps.indexJson.size} JSON / ${maps.indexHtml.size} HTML conversations; ${mismatches} data mismatches.`);
    }else check('JSON / HTML agreement','NOT CHECKED','Supply both converted files to check their agreement.');
    if(inputs.byRole.originalHtml&&inputs.byRole.original){let count=0;for(const id of new Set([...maps.original.keys(),...maps.originalHtml.keys()]))if(maps.original.get(id)?.digest!==maps.originalHtml.get(id)?.digest)count++;check('Original JSON / HTML',count?'REVIEW':'PASS',`${count} differing conversations in the original inputs.`);if(count)add('warning','SOURCE_PAIR','The supplied original JSON and original HTML datasets differ. Reference comparison uses the JSON source.');}
    let baseline={};
    const bp=spec.baseline||path.join(__dirname,'../vendor/known-schema.json');
    if(!fs.existsSync(bp))throw new Error('Schema baseline is unavailable.');
    if(fs.existsSync(bp)){
      const b=JSON.parse(await fs.promises.readFile(bp,'utf8'));baseline=b.inventory||b.schema?.inventory;
      if(!baseline||typeof baseline!=='object'||Array.isArray(baseline))throw new Error('Invalid schema baseline: missing inventory object.');
      r.schema.baseline=spec.baseline?path.basename(spec.baseline):'Bundled known-field inventory';
    }
    r.schema.inventory=inventory;r.schema.signature=signature(inventory);r.schema.changes=compareSchema(inventory,baseline);r.schema.basis=inputs.byRole.original?'original':'converted only';
    for(const change of r.schema.changes)add('warning','SCHEMA_CHANGE',(change.kind==='new'?'New schema feature: ':'New value type: ')+change.key+' ('+change.types.join(', ')+').',{id:change.first?.conversationId,title:change.first?.title,file:change.first?.file});
    check('Schema inventory',r.schema.changes.length?'REVIEW':'PASS',`${Object.keys(inventory).length} features; ${r.schema.changes.length} additions/type changes relative to ${r.schema.baseline||'empty baseline'}.`);
    if(r.findings.length<r.counts.total){r.limitations.push(`Finding evidence capped at ${limit}; ${r.counts.total-r.findings.length} further findings counted but not retained.`);check('Finding retention','INCOMPLETE','Increase the finding limit and inspect again.');}
    const missing=!inputs.byRole.original||!inputs.byRole.indexJson||!inputs.byRole.indexHtml;
    const retainedAll=r.findings.length===r.counts.total;
    r.status=r.counts.errors?'FAIL':r.counts.warnings?'REVIEW':missing||!retainedAll?'LIMITED':'PASS';
    r.conclusion=r.status==='FAIL'?'Confirmed mismatches or input errors require attention.':r.status==='REVIEW'?'Review the flagged candidates and schema changes; they are not automatically conversion defects.':r.status==='LIMITED'?'No issues detected in available checks. Comparison inputs or retained evidence are incomplete.':'All available deterministic checks passed against the selected reference rules.';
    if(!r.counts.conversations&&!r.counts.errors){r.status='LIMITED';r.conclusion='No converted conversations were available to inspect.';}
    r.statusLabel={PASS:'Passed',REVIEW:'Review needed',FAIL:'Failed',LIMITED:'Limited coverage'}[r.status];
    r.coverage={hasOriginal:!!inputs.byRole.original,hasJson:!!inputs.byRole.indexJson,hasHtml:!!inputs.byRole.indexHtml,sourcePairs,userChecks,complete:!missing&&retainedAll&&!r.files.some(f=>f.error)&&r.counts.conversations>0,retainedAll,missing:['original','indexJson','indexHtml'].filter(role=>!inputs.byRole[role])};
    r.durationMs=Date.now()-start;
    const result={report:r,contexts,inputs,profiles,maps};
    if(!keepInputs)await inputs.cleanup();
    return result;
  }catch(e){if(inputs)await inputs.cleanup();throw e;}
}
async function evidence(result,id){
  const f=result.report.findings.find(f=>f.id===id),ctx=result.contexts.get(id);if(!f||!ctx)throw new Error('Finding not found');
  const sourcePointer=ctx.source||(ctx.role==='original'?ctx.target:null)||result.maps.original.get(ctx.id)?.pointer;
  const targetPointer=ctx.role==='original'?(result.maps.indexJson.get(ctx.id)?.pointer||result.maps.indexHtml.get(ctx.id)?.pointer):ctx.target;
  const source=sourcePointer?await readPointer(sourcePointer):null,actual=targetPointer?await readPointer(targetPointer):null;
  const expected=source?structuredClone(source):ctx.other?await readPointer(ctx.other):null;
  if(source)reference.transformObj(expected,profiles[result.report.profileIndex??7].set);
  const show=x=>{const v=f.pointer==='/'?x:get(x,f.pointer);return v===undefined?'[Value absent]':v===null?'[No evidence available]':typeof v==='string'?v:JSON.stringify(v,null,2);};
  const limit=1024*1024, truncated={}, originalBytes={};
  const bound=(value,name)=>{
    const text=show(value);originalBytes[name]=Buffer.byteLength(text,'utf8');truncated[name]=originalBytes[name]>limit;
    if(!truncated[name])return text;
    const bytes=Buffer.from(text.slice(0,limit),'utf8');let end=limit;
    while(end>0&&(bytes[end]&0xc0)===0x80)end--;
    return bytes.subarray(0,end).toString('utf8')+'\n[Preview truncated at 1 MiB. Inspect the saved input file for the complete value.]';
  };
  return {finding:f,source:bound(source,'source'),expected:bound(expected,'expected'),actual:bound(actual,'actual'),truncated,originalBytes,previewLimitBytes:limit};
}
module.exports={audit,evidence,profiles,profileIndex,knownShell,diff,scanContent,inspectGraph,unknownSource};
