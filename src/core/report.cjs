'use strict';
const path = require('node:path');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function publicReport(report, includeEvidence = false) {
  const copy = structuredClone(report);
  const privatePaths = [...(report.protectedFiles || []), ...(report.files || []).map(f => f.path)].filter(p => typeof p === 'string' && p).sort((a,b) => b.length-a.length);
  delete copy._index;
  delete copy.protectedFiles;
  for (const file of copy.files || []) delete file.path;
  for (const finding of copy.findings || []) {
    delete finding._context;
    if (!includeEvidence) for (const field of ['expected','actual','source']) delete finding[field];
  }
  // Errors can contain filesystem paths. Remove the known input paths there too.
  function redact(value) {
    if (typeof value === 'string') {
      for (const privatePath of privatePaths) value = value.split(privatePath).join(path.basename(privatePath));
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') for (const key of Object.keys(value)) value[key] = redact(value[key]);
    return value;
  }
  return redact(copy);
}
function csvCell(value) {
  let text = String(value ?? '');
  // Quote alone does not prevent formula execution in spreadsheet applications.
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function toCsv(report) {
  const r = publicReport(report);
  const rows = [['Kind','Status / severity','Rule / check','File','Conversation','Conversation ID','Node ID','JSON pointer','Detail']];
  rows.push(['Summary', r.status, r.profile, '', '', '', '', '', r.conclusion]);
  rows.push(['Counts', '', '', '', '', '', '', '', `Conversations: ${r.counts?.conversations ?? 0}; errors: ${r.counts?.errors ?? 0}; warnings: ${r.counts?.warnings ?? 0}; information: ${r.counts?.info ?? 0}`]);
  for (const check of r.checks || []) rows.push(['Check', check.status, check.name, '', '', '', '', '', check.detail]);
  for (const input of r.files || []) rows.push(['Input', '', input.role, input.name, '', '', '', '', `${input.records ?? 0} records; SHA-256: ${input.sha256 || 'Unavailable'}`]);
  for (const finding of r.findings || []) rows.push(['Finding', finding.severity, finding.rule, finding.file, finding.title, finding.conversationId, finding.nodeId, finding.pointer, finding.message]);
  for (const limitation of r.limitations || []) rows.push(['Limitation', '', '', '', '', '', '', '', limitation]);
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
function toHtml(report) {
  const r = publicReport(report), checks = r.checks || [], files = r.files || [], findings = r.findings || [];
  const rows = (items, render, empty, columns) => items.length ? items.map(render).join('') : `<tr><td colspan="${columns}">${empty}</td></tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>ChatGPT Export Processor — validation report</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#f4f7fb;color:#142338}body{max-width:1200px;margin:2.5rem auto;padding:0 1.5rem}h1{font-size:2rem}h2{margin-top:2rem}p{line-height:1.6}table{border-collapse:collapse;width:100%;font-size:.9rem}td,th{padding:.65rem;border-bottom:1px solid #7890ae66;text-align:left;overflow-wrap:anywhere;vertical-align:top}code{overflow-wrap:anywhere}.tag{display:inline-block;background:#3c88df22;padding:.3rem .6rem;border-radius:6px;font-weight:600}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}.table-wrap{overflow:auto}footer{margin-top:2rem;font-size:.85rem;opacity:.8}@media(prefers-color-scheme:dark){:root{background:#080c12;color:#e6edf7}.tag{background:#132c49;color:#9ac8ff}}@media print{body{margin:0}details{display:block}tr{break-inside:avoid}}</style></head><body>
<h1>ChatGPT Export Processor <small>${esc(r.version)}</small></h1><p class="tag">${esc(r.statusLabel || r.status)}</p><p>${esc(r.conclusion)}</p><p>${esc(r.createdAt)} · Rules: ${esc(r.ruleVersion)} · Writing profile: ${esc(r.profile)}</p>
<p>Conversations: ${esc(r.counts?.conversations ?? 0)} · Errors: ${esc(r.counts?.errors ?? 0)} · Warnings: ${esc(r.counts?.warnings ?? 0)} · Information: ${esc(r.counts?.info ?? 0)}</p>
<h2>Coverage</h2><div class="table-wrap"><table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>${rows(checks, x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.status)}</td><td>${esc(x.detail)}</td></tr>`, 'No checks recorded.', 3)}</tbody></table></div>
<h2>Inputs</h2><div class="table-wrap"><table><thead><tr><th>Input</th><th>Records</th><th>SHA-256</th></tr></thead><tbody>${rows(files, f=>`<tr><td>${esc(f.name)}</td><td>${esc(f.records ?? '—')}</td><td><code>${esc(f.sha256 || 'Unavailable')}</code></td></tr>`, 'No inputs recorded.', 3)}</tbody></table></div>
<h2>Findings (${esc(r.counts?.total ?? findings.length)})</h2><div class="table-wrap"><table><thead><tr><th>Level / rule</th><th>Location</th><th>Observation</th></tr></thead><tbody>${rows(findings, f=>`<tr><td>${esc(f.severity)}<br>${esc(f.rule)}</td><td>${esc(f.file)}<br>${esc(f.title)}<br><code>${esc(f.pointer)}</code></td><td>${esc(f.message)}</td></tr>`, 'No findings retained. Check coverage and limitations before drawing conclusions.', 3)}</tbody></table></div>
<h2>Limits</h2><ul>${(r.limitations || []).map(s=>`<li>${esc(s)}</li>`).join('')}</ul><details><summary>Schema signature and inventory</summary><pre>${esc(JSON.stringify(r.schema || {},null,2))}</pre></details>
<footer>Copyright © 2026 davoda1 · MIT. This local report can contain file names, conversation titles, identifiers and schema details. Share it only after reviewing its contents.</footer></body></html>`;
}
module.exports = {publicReport, toCsv, toHtml, esc, csvCell};
