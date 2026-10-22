'use strict';
const {hash,canonical}=require('./reader.cjs');
const type=v=>v===null?'null':Array.isArray(v)?'array':typeof v;
function collectSchema(c, inventory, location) {
  function add(key,value) {
    const entry=inventory[key] ||= {types:{},count:0,first:location};
    entry.count++;entry.types[type(value)]=(entry.types[type(value)]||0)+1;
  }
  function fields(o,prefix){if(o && typeof o==='object' && !Array.isArray(o)) for(const [k,v]of Object.entries(o))add(prefix+'.'+k,v);}
  fields(c,'conversation');
  for(const [nodeId,n]of Object.entries(c.mapping||{})) {
    fields(n,'node'); const m=n?.message;if(!m)continue;
    fields(m,'message');fields(m.author,'author');fields(m.content,'content');fields(m.metadata,'metadata');
    add('role:'+String(m.author?.role),true); add('content_type:'+String(m.content?.content_type),true);
    for(const part of (Array.isArray(m.content?.parts)?m.content.parts:[])) {
      if(part && typeof part==='object') {fields(part,'part'); if(part.content_type)add('part_type:'+part.content_type,true);}
      if(typeof part==='string' && m.author?.role!=='user') {
        for(const match of part.matchAll(/\ue200([a-z][a-z0-9_]{0,79})(?:\ue202([^\ue200\ue201]*))?\ue201/gi)) {
          add('marker:'+match[1],true);
          if(match[1]==='genui'){try{const payload=JSON.parse(match[2]); if(payload && typeof payload==='object'&&!Array.isArray(payload))for(const key of Object.keys(payload))add('genui:'+key,true);}catch{add('genui:opaque',true);}}
        }
        for(const match of part.matchAll(/:::writing\{[^\n]*variant="([^"]+)"/g))add('writing:'+match[1],true);
      }
    }
    for(const r of (Array.isArray(m.metadata?.content_references)?m.metadata.content_references:[])){fields(r,'reference');if(r?.type)add('reference_type:'+r.type,true);if(r?.type==='dil' && typeof r.name==='string' && /^[a-z][a-z0-9_]{0,100}$/i.test(r.name))add('widget:'+r.name,true);}
  }
}
function signature(inventory){return hash(canonical(Object.fromEntries(Object.keys(inventory).sort().map(k=>[k,Object.keys(inventory[k].types).sort()]))));}
function compareSchema(current,baseline){
  const result=[];
  for(const [key,entry]of Object.entries(current)){
    if(!baseline[key])result.push({kind:'new',key,types:Object.keys(entry.types),count:entry.count,first:entry.first});
    else {const added=Object.keys(entry.types).filter(t=>!baseline[key].types[t]);if(added.length)result.push({kind:'type',key,types:added,count:entry.count,first:entry.first});}
  }
  return result;
}
module.exports={collectSchema,signature,compareSchema};
