'use strict';
const fs = require('node:fs'), crypto = require('node:crypto');
const CHUNK = 1024 * 1024, MAX_RECORD = 128 * 1024 * 1024;
const hash = b => crypto.createHash('sha256').update(b).digest('hex');

// A strict byte-oriented array reader. Uploaded JavaScript is never executed.
// Keeping byte spans permits evidence to be loaded later without retaining archives.
async function* readRecords(file, meta = {}, onProgress = () => {}, {signal} = {}) {
  if (signal?.aborted) { const e=new Error('Operation cancelled.'); e.name='AbortError'; throw e; }
  const input = fs.createReadStream(file, {highWaterMark: CHUNK, signal});
  const isHtml = /\.html?$/i.test(file);
  let offset = 0, state = isHtml ? 'seek' : 'open', prefix = Buffer.alloc(0);
  let chunks = [], segment = -1, size = 0, start = 0, depth = 0, quote = false, escape = false;
  let record = 0, suffix = [], suffixSize = 0;
  const sha = crypto.createHash('sha256');
  const decode = b => new TextDecoder('utf-8', {fatal: true}).decode(b);
  function fail(s) { throw new Error(`${s} (byte ${offset}, record ${record + 1})`); }
  try {
    for await (let block of input) {
      if (signal?.aborted) { const e=new Error('Operation cancelled.'); e.name='AbortError'; throw e; }
      sha.update(block);
      let i = 0;
      if (state === 'seek') {
        prefix = Buffer.concat([prefix, block]);
        // Latin-1 keeps ASCII match offsets identical to UTF-8 byte offsets.
        const m = /(?:var|let|const)\s+jsonData\s*=\s*/m.exec(prefix.toString('latin1'));
        if (!m) { if (prefix.length > 16 * CHUNK) fail('Unrecognized HTML data wrapper'); offset += block.length; continue; }
        const end = m.index + m[0].length;
        meta.prefixSha256 = hash(prefix.subarray(0, end));
        meta.prefixBytes = end;
        block = prefix.subarray(end); offset = end; prefix = Buffer.alloc(0); state = 'open';
      }
      for (; i < block.length; i++, offset++) {
        const b = block[i];
        if (state === 'tail') {
          if (isHtml) {
            const rest = block.subarray(i); suffixSize += rest.length;
            if (suffixSize > 16 * CHUNK) fail('HTML suffix exceeds the 16 MiB inspection limit');
            suffix.push(rest); offset += rest.length; i = block.length; break;
          }
          if (![9,10,13,32].includes(b)) fail('Unexpected content after JSON array');
          continue;
        }
        if (state !== 'record' && [9,10,13,32].includes(b)) continue;
        if (state === 'open') {
          // UTF-8 BOM is accepted only at the beginning.
          if (offset === 0 && b === 239 && block[i+1] === 187 && block[i+2] === 191) { i += 2; offset += 2; continue; }
          if (b !== 91) fail('Expected a top-level JSON array');
          state = 'first'; continue;
        }
        if (state === 'comma') {
          if (b === 93) { state = 'tail'; continue; }
          if (b !== 44) fail('Missing comma between conversations');
          state = 'next'; continue;
        }
        if (state === 'first' || state === 'next') {
          if (b === 93 && state === 'first') { state = 'tail'; continue; }
          if (b !== 123) fail('Expected a conversation object (trailing commas are invalid)');
          state = 'record'; start = offset; segment = i; depth = 1; quote = false; escape = false; continue;
        }
        if (state === 'record') {
          if (quote) { if (escape) escape = false; else if (b === 92) escape = true; else if (b === 34) quote = false; }
          else if (b === 34) quote = true;
          else if (b === 123 || b === 91) depth++;
          else if (b === 125 || b === 93) depth--;
          if (depth > 256) fail('Nesting exceeds the 256-level inspection limit');
          if (depth === 0) {
            chunks.push(block.subarray(segment, i+1)); size += i+1-segment;
            if (size > MAX_RECORD) fail('Conversation exceeds the 128 MiB inspection limit');
            const raw = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
            const text = decode(raw), value = JSON.parse(text,(key,value,context)=>{
              if(typeof value==='number'&&(!Number.isFinite(value)||Object.is(value,-0)||(Number.isInteger(value)&&!Number.isSafeInteger(value))||(value===0&&context?.source&&/[1-9]/.test(context.source.split(/[eE]/)[0]))))throw new Error('Numeric value outside the supported finite/exact-integer range, negative zero or numeric underflow; preservation cannot be certified.');
              return value;
            });
            const duplicates = duplicateKeys(text);
            record++;
            yield {value, duplicates, pointer: {file, offset:start, length:raw.length, sha256:hash(raw)}, ordinal:record-1};
            chunks = []; size = 0; segment = -1; state = 'comma';
          }
        }
      }
      if (state === 'record') {
        if (segment < 0) segment = 0;
        chunks.push(block.subarray(segment)); size += block.length-segment; segment = 0;
        if (size > MAX_RECORD) fail('Conversation exceeds the 128 MiB inspection limit');
      }
      onProgress(offset);
    }
    if (state !== 'tail') fail('Truncated or empty input');
    if (isHtml) {
      const tail = Buffer.concat(suffix); decode(tail);
      meta.suffixSha256 = hash(tail); meta.suffixBytes = tail.length;
      meta.htmlClosings = (tail.toString().match(/<\/html\s*>/gi) || []).length;
    }
    meta.sha256 = sha.digest('hex'); meta.records = record;
  } finally { input.destroy(); }
}

function duplicateKeys(text) {
  // Called only after JSON.parse. Object keys are strings immediately followed by ':'.
  const stack = [], duplicates = []; let i=0;
  while (i < text.length) {
    const c=text[i++];
    if (c==='{' || c==='[') stack.push(c==='{' ? new Set() : null);
    else if (c==='}' || c===']') stack.pop();
    else if (c==='"') {
      const begin=i-1; let esc=false;
      while (i<text.length) {const x=text[i++]; if (esc) esc=false; else if (x==='\\') esc=true; else if(x==='"') break;}
      const end=i; while (/\s/.test(text[i] || '') && i<text.length) i++;
      if (text[i]===':' && stack.at(-1)) {const k=JSON.parse(text.slice(begin,end)); if(stack.at(-1).has(k)) duplicates.push({key:k,characterOffset:begin}); stack.at(-1).add(k);}
    }
  }
  return duplicates;
}
async function readPointer(p) {
  const f=await fs.promises.open(p.file,'r');
  try {const b=Buffer.alloc(p.length);let n=0;while(n<b.length){const r=await f.read(b,n,b.length-n,p.offset+n);if(!r.bytesRead)throw new Error('Input changed or became truncated');n+=r.bytesRead;}if(p.sha256&&hash(b)!==p.sha256)throw new Error('Input changed since inspection; run the inspection again.');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}
  finally {await f.close();}
}
function canonical(value) {
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
module.exports={readRecords,readPointer,hash,canonical,duplicateKeys};
