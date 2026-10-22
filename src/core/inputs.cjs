'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const {Transform} = require('node:stream');
const yauzl = require('yauzl');
const CRC = require('crc-32');
const MAX_ENTRY = 4 * 1024 ** 3;
const MAX_TOTAL = 16 * 1024 ** 3;
const MAX_ENTRIES = 100000;
function checkAbort(signal) {
  if (signal?.aborted) {
    const error = new Error('Operation cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}
const roleFor = name => {
  const b = path.posix.basename(name.replace(/\\/g, '/')).toLowerCase();
  if (b === 'conversations-index.json') return 'indexJson';
  if (b === 'chat-index.html') return 'indexHtml';
  if (/^conversations(?:-\d+)?\.json$/.test(b)) return 'original';
  if (b === 'chat.html') return 'originalHtml';
  return null;
};
async function digest(file, {signal} = {}) {
  checkAbort(signal);
  const h = crypto.createHash('sha256');
  for await (const b of fs.createReadStream(file, {signal})) h.update(b);
  return h.digest('hex');
}
function safeEntry(entry) {
  const name = entry.fileName;
  if (!name || name.length > 4096 || /[\x00-\x1f]/.test(name) || name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(x => x === '..')) throw new Error('Unsafe ZIP entry path.');
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (unixMode === 0xa000) throw new Error('ZIP symbolic links are unsupported.');
}
async function unpackZip(file, destination, progress = () => {}, {signal, maxEntry = MAX_ENTRY, maxTotal = MAX_TOTAL, maxEntries = MAX_ENTRIES, roles = null} = {}) {
  checkAbort(signal);
  const zip = await new Promise((res, rej) => yauzl.open(file, {lazyEntries:true, autoClose:false, validateEntrySizes:true, strictFileNames:true}, (e,z) => e ? rej(e) : res(z)));
  const found = [], seen = new Set();
  let total = 0;
  const abort = () => zip.close();
  signal?.addEventListener('abort', abort, {once:true});
  try {
    const entries = await new Promise((resolve,reject) => {
      const all = [];
      const onAbort = () => {const e=new Error('Operation cancelled.');e.name='AbortError';reject(e);};
      signal?.addEventListener('abort', onAbort, {once:true});
      const finish = (error, result) => {signal?.removeEventListener('abort', onAbort); error ? reject(error) : resolve(result);};
      zip.once('error', e => finish(e));
      zip.once('end', () => finish(null, all));
      zip.on('entry', e => {
        try {checkAbort(signal); safeEntry(e); if (all.length >= maxEntries) throw new Error('ZIP entry-count limit exceeded.'); all.push(e); zip.readEntry();}
        catch(error) {finish(error); zip.close();}
      });
      zip.readEntry();
    });
    for (const e of entries) {
      checkAbort(signal);
      const role = roleFor(e.fileName);
      if (!role || (roles && !roles.has(role))) continue;
      if (e.generalPurposeBitFlag & 1) throw new Error('Encrypted ZIP entries are unsupported. Select extracted JSON/HTML files.');
      const unique = role === 'original' ? path.posix.basename(e.fileName).toLowerCase() : role;
      if (seen.has(unique)) throw new Error(`Ambiguous ZIP: more than one ${unique}. Select files explicitly.`);
      seen.add(unique);
      if (!Number.isSafeInteger(e.uncompressedSize) || e.uncompressedSize > maxEntry || total + e.uncompressedSize > maxTotal) throw new Error('Archive exceeds inspection size limits.');
      total += e.uncompressedSize;
      const target = path.join(destination, String(found.length) + (role.endsWith('Html') ? '.html' : '.json'));
      const stream = await new Promise((res,rej) => zip.openReadStream(e, (err,s) => err ? rej(err) : res(s)));
      let crc = 0, bytes = 0;
      const check = new Transform({transform(chunk, enc, cb) {
        bytes += chunk.length;
        if (bytes > maxEntry || bytes > e.uncompressedSize) return cb(new Error('Archive entry exceeded size limit.'));
        crc = CRC.buf(chunk, crc); cb(null, chunk);
      }});
      progress({phase:'Reading ZIP', detail:path.posix.basename(e.fileName)});
      await pipeline(stream, check, fs.createWriteStream(target, {flags:'wx', mode:0o600}), {signal});
      if ((crc >>> 0) !== e.crc32 || bytes !== e.uncompressedSize) throw new Error('ZIP CRC/size mismatch: ' + path.posix.basename(e.fileName));
      found.push({file:target, role, label:path.basename(file)+' :: '+path.posix.basename(e.fileName), archive:file, entry:e.fileName});
    }
    if (!found.length) throw new Error('No recognized conversations JSON or chat HTML files in ZIP.');
    return found.sort((a,b) => a.entry.localeCompare(b.entry, 'en', {numeric:true}));
  } finally {
    signal?.removeEventListener('abort', abort);
    zip.close();
  }
}
async function resolveInputs(spec, progress = () => {}, {signal} = {}) {
  checkAbort(signal);
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chatgpt-export-inspect-'));
  progress({temporary:temp});
  const descriptors = [], requests = new Map(), protectedFiles = new Set();
  const allRoles = ['original','indexJson','indexHtml','originalHtml'];
  try {
    for (const role of allRoles) {
      if (!spec[role]) continue;
      const files = Array.isArray(spec[role]) ? spec[role] : [spec[role]];
      for (const file of files) {
        checkAbort(signal);
        if (typeof file !== 'string' || !file) throw new Error('Input paths must be nonempty strings.');
        const real = await fs.promises.realpath(file), stat = await fs.promises.stat(real);
        if (!stat.isFile()) throw new Error('Expected a regular input file.');
        protectedFiles.add(real);
        if (!requests.has(real)) requests.set(real, new Set());
        requests.get(real).add(role);
      }
    }
    const explicit = Object.fromEntries(allRoles.map(role => [role,[...requests.values()].some(roles => roles.has(role))]));
    let zipCount = 0;
    for (const [real, requested] of requests) {
      checkAbort(signal);
      if (/\.zip$/i.test(real)) {
        // An explicitly selected source wins over a source bundled with converted files.
        // Equally, a source ZIP must not silently replace separately selected outputs.
        const accepted = new Set(allRoles.filter(role => {
          if (explicit[role]) return requested.has(role);
          if (role === 'originalHtml' && explicit.original) return requested.has('original');
          if (role === 'indexJson' || role === 'indexHtml') {
            if (requested.has('original') && (explicit.indexJson || explicit.indexHtml) && !requested.has('indexJson') && !requested.has('indexHtml')) return false;
          }
          return true;
        }));
        const dir = path.join(temp, String(++zipCount));
        await fs.promises.mkdir(dir, {mode:0o700});
        descriptors.push(...await unpackZip(real, dir, progress, {signal,roles:accepted}));
      } else for (const role of requested) descriptors.push({file:real, role, label:path.basename(real)});
    }
    const byRole = Object.create(null);
    for (const d of descriptors) (byRole[d.role] ||= []).push(d);
    for (const role of ['indexJson','indexHtml','originalHtml']) if (byRole[role]?.length > 1) throw new Error('Multiple '+role+' inputs. Choose either a bundle or a separate file.');
    if (!byRole.indexJson && !byRole.indexHtml) throw new Error('Select a converted JSON or HTML file, or a bundle containing them.');
    return {byRole, descriptors, temp, protectedFiles:[...protectedFiles], cleanup:() => fs.promises.rm(temp, {recursive:true, force:true})};
  } catch(error) {await fs.promises.rm(temp, {recursive:true, force:true});throw error;}
}

module.exports = {resolveInputs, unpackZip, roleFor, digest, checkAbort, MAX_ENTRY, MAX_TOTAL, MAX_ENTRIES};
