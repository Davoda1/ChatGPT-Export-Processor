'use strict';

const api = window.processor;
const $ = id => document.getElementById(id);
const state = { page: 'workspace', mode: 'convert', selection: {}, result: null, running: false, choosing: false, theme: 'system', density: 'comfortable', selected: null, outputAvailable: false, evidence: null, tab: 'actual', findingLimit: 150 };
const pageInfo = {
  workspace: ['A clear path from export to archive', 'Your workspace', 'Convert a ChatGPT export, or inspect an existing conversion.'],
  overview: ['Understand the result', 'Inspection overview', 'See what passed, what needs attention, and what could not be checked.'],
  findings: ['Follow the evidence', 'Findings', 'Review observations alongside original and converted content.'],
  schema: ['Notice what changed', 'Schema watch', 'Discover new fields and formats without treating every change as a defect.'],
  reports: ['Keep the evidence', 'Reports', 'Save the checks, their coverage, and the details you need.'],
  settings: ['Make it your workspace', 'Settings', 'Appearance and information about this application.'],
};
const statusNames = { PASS: 'Passed', REVIEW: 'Review needed', FAIL: 'Failed', LIMITED: 'Limited coverage', 'NOT CHECKED': 'Not checked', INCOMPLETE: 'Incomplete' };
const statusClasses = { PASS: 'ok', REVIEW: 'warn', FAIL: 'bad', LIMITED: 'info', 'NOT CHECKED': 'info', INCOMPLETE: 'warn' };
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let toastTimer, modalFocus, evidenceSequence = 0;

function node(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = String(value);
  return item;
}
function button(label, handler, className = 'btn small', iconName) {
  const item = node('button', className);
  if (iconName) item.append(makeIcon(iconName));
  item.append(node('span', '', label)); item.addEventListener('click', handler); return item;
}
function badge(status, label) { return node('span', 'badge ' + (statusClasses[status] || 'info'), label || statusNames[status] || status); }
function text(value, fallback = 'Not available') { return value === undefined || value === null || value === '' ? fallback : typeof value === 'string' ? value : JSON.stringify(value); }
function displayCount(value) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—'; }
function bytes(value) { if (!Number.isFinite(Number(value))) return 'Size unavailable'; const n = Number(value); if(n < 1024) return n + ' B'; if(n < 1048576) return (n / 1024).toFixed(1) + ' KiB'; if(n < 1073741824) return (n / 1048576).toFixed(1) + ' MiB'; return (n / 1073741824).toFixed(2) + ' GiB'; }
function empty(title, description, iconName = 'info') { const box = node('div', 'empty'); box.append(makeIcon(iconName), node('h3', '', title), node('p', '', description)); return box; }
function toast(message) { $('toast').textContent = String(message); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
function showError(error) { const message = typeof error === 'string' ? error : error?.message || 'The action could not be completed.'; $('workspaceError').textContent = message; $('workspaceError').hidden = false; $('footerStatus').textContent = 'Action could not be completed'; if (state.page !== 'workspace') toast(message); }
function clearError() { $('workspaceError').hidden = true; $('workspaceError').textContent = ''; }
async function action(callback) { try { return await callback(); } catch (error) { showError(error); return null; } }
function navigate(page) {
  if (!pageInfo[page]) return;
  state.page = page;
  for (const item of document.querySelectorAll('[data-page]')) {
    if (item.dataset.page === page) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  }
  for (const view of document.querySelectorAll('.view')) view.classList.toggle('active', view.id === 'view-' + page);
  const [eyebrow, title, subtitle] = pageInfo[page];
  $('eyebrow').textContent = eyebrow; $('pageTitle').textContent = title; $('pageSubtitle').textContent = subtitle;
  $('headAction').hidden = !state.result || ['workspace', 'settings', 'reports'].includes(page);
  if (page === 'findings') renderFindings();
  if (page === 'schema') renderSchema();
}
function selectionName(role, fallback) { return state.selection[role]?.name || fallback; }
function updateWorkspace() {
  const inspecting = state.mode === 'inspect';
  $('modeConvert').setAttribute('aria-pressed', String(!inspecting)); $('modeInspect').setAttribute('aria-pressed', String(inspecting));
  $('inputTitle').textContent = inspecting ? '01 Inputs' : '01 Original export';
  $('optionsTitle').textContent = inspecting ? '02 Inspection rules' : '02 Conversion options';
  $('inspectInputs').hidden = !inspecting; $('inspectSourceLabel').hidden = !inspecting; $('convertInputBadge').hidden = inspecting;
  $('convertOptions').hidden = inspecting; $('inspectOptions').hidden = !inspecting;
  $('destinationStrip').hidden = inspecting; $('outputsNote').hidden = inspecting;
  $('originalName').textContent = selectionName('original', inspecting ? 'Original export (optional)' : 'Choose your export');
  $('originalName').title = $('originalName').textContent;
  $('originalMeta').textContent = inspecting ? 'ZIP or JSON · preservation baseline' : 'A ZIP downloaded from ChatGPT';
  $('chooseOriginal').textContent = state.selection.original ? 'Change export' : 'Choose export';
  for (const [role, fallback] of [['indexJson', 'Converted JSON'], ['indexHtml', 'Converted HTML'], ['bundle', 'Processed output ZIP'], ['outputDir', 'Choose a destination folder']]) {
    $(role + 'Name').textContent = selectionName(role, fallback); $(role + 'Name').title = $(role + 'Name').textContent;
  }
  const bundle = $('inspectSource').value === 'bundle';
  $('separateInputs').hidden = bundle; $('bundleInput').hidden = !bundle;
  const ready = inspecting ? (bundle ? !!state.selection.bundle : !!(state.selection.indexJson || state.selection.indexHtml)) : !!(state.selection.original && /\.zip$/i.test(state.selection.original.name) && state.selection.outputDir);
  $('run').disabled = !ready || state.running || state.choosing;
  $('runLabel').textContent = inspecting ? 'Inspect conversion' : 'Convert & validate';
  $('readiness').textContent = inspecting ? (ready ? (state.selection.original || bundle ? 'Ready to inspect selected inputs.' : 'No original selected. Coverage will be limited.') : 'Choose converted files or an output bundle.') : ready ? 'A new output folder will be created.' : 'Choose a ChatGPT ZIP export and output folder.';
  $('runHint').hidden = state.running; $('progressArea').hidden = !state.running; $('cancelRun').hidden = !state.running;
  for (const el of document.querySelectorAll('#modeConvert,#modeInspect,#inspectSource,#profile,#convertOptions input,[data-choose],#chooseOutput')) el.disabled = state.running || state.choosing;
  for (const el of document.querySelectorAll('[data-clear]')) { el.hidden = !state.selection[el.dataset.clear]; el.disabled = state.running || state.choosing; }
  $('footerStatus').textContent = state.running ? 'Processing · inputs preserved' : state.result ? 'Last result: ' + (state.result.statusLabel || statusNames[state.result.status] || state.result.status) : 'Ready · local processing';
}
async function choose(role) {
  if (state.running || state.choosing) return;
  state.choosing = true; clearError(); updateWorkspace();
  try {
    const selected = role === 'outputDir' ? await api.chooseOutput() : await api.chooseInput(role);
    if (selected) {
      if (selected.selection) state.selection = selected.selection;
      else if (selected.name || selected.token) state.selection[role] = selected;
      else state.selection = selected;
    }
  } catch (error) { showError(error); }
  finally { state.choosing = false; updateWorkspace(); }
}
async function clearInput(role) {
  if (state.running || state.choosing) return;
  const selection = await action(() => api.clearInput(role));
  if (selection) state.selection = selection.selection || selection;
  updateWorkspace();
}
async function startRun() {
  if ($('run').disabled) return;
  clearError(); state.running = true; state.result = null; state.outputAvailable = false; state.selected = null; state.evidence = null; evidenceSequence++; renderResult();
  $('phase').textContent = 'Preparing'; $('percent').textContent = ''; $('progress').removeAttribute('value'); $('progressDetail').textContent = '';
  updateWorkspace();
  try {
    const result = await api.start({ mode: state.mode, inspectionSource: $('inspectSource').value, options: { standard: $('optionStandard').checked, document: $('optionDocument').checked, chatMessage: $('optionChat').checked }, profile: $('profile').value });
    if (result?.error) throw new Error(result.error);
    if (result?.started === false) { state.running = false; updateWorkspace(); }
  } catch (error) { state.running = false; updateWorkspace(); showError(error); }
}
async function cancelRun() {
  $('cancelRun').disabled = true;
  try { await api.cancel(); }
  catch (error) { showError(error); }
  finally { $('cancelRun').disabled = false; }
}
function onEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'progress') {
    const p = event.value || {}; state.running = true; updateWorkspace();
    $('phase').textContent = p.phase || 'Processing'; $('progressDetail').textContent = p.detail || '';
    const amount = Number.isFinite(p.percent) ? p.percent : Number.isFinite(p.ratio) ? p.ratio * 100 : null;
    if (amount === null) { $('progress').removeAttribute('value'); $('percent').textContent = ''; }
    else { $('progress').max = 100; $('progress').value = Math.max(0, Math.min(100, amount)); $('percent').textContent = Math.floor($('progress').value) + '%'; }
  } else if (event.type === 'complete') {
    state.running = false; state.result = event.value?.report || event.value; state.outputAvailable = event.outputAvailable === true; state.selected = null; state.evidence = null;
    renderResult(); updateWorkspace(); navigate('overview');
  } else if (event.type === 'error') {
    state.running = false; updateWorkspace(); showError(event.error || event.value?.error || 'Processing failed.');
  } else if (event.type === 'cancelled') {
    state.running = false; updateWorkspace(); $('footerStatus').textContent = 'Cancelled · original files unchanged'; toast('Processing cancelled. Original files were not changed.');
  }
}
function renderResult() {
  renderOverview(); renderFindings(); renderSchema();
  const findings = state.result?.findings || [];
  $('navCount').textContent = displayCount(findings.length); $('navCount').hidden = !findings.length;
  $('reportState').textContent = state.result ? state.result.statusLabel || statusNames[state.result.status] || state.result.status : 'No inspection yet';
  for (const btn of document.querySelectorAll('[data-export]')) btn.disabled = !state.result;
}
function panel(title) { const box = node('div', 'panel'); const head = node('div', 'panel-head'); head.append(node('h2', '', title)); box.append(head); return box; }
function kv(label, value) { const row = node('div', 'kv'); row.append(node('span', '', label), node('strong', '', text(value))); return row; }
function renderOverview() {
  const root = $('overviewContent'); root.replaceChildren(); const r = state.result;
  if (!r) { root.append(empty('No inspection yet', 'Choose a ChatGPT export to convert, or select existing converted files to inspect.', 'shield')); return; }
  const hero = node('div', 'summary-hero'), icon = node('div', 'status-icon status-' + String(r.status || '').toLowerCase()), summary = node('div', 'grow');
  icon.append(makeIcon(r.status === 'PASS' ? 'check' : r.status === 'LIMITED' ? 'info' : 'alert'));
  summary.append(node('span', 'label', 'Inspection complete'), node('h2', '', r.statusLabel || statusNames[r.status] || r.status));
  const descriptions = { PASS: 'The available checks passed. Review the coverage and scope below.', REVIEW: 'Review the findings before relying on the converted archive.', FAIL: 'Confirmed errors were found. Review the findings and preserve your original export.', LIMITED: 'Some required evidence is unavailable. Full preservation could not be checked.' };
  summary.append(node('p', '', descriptions[r.status] || 'Review the check results and their coverage.'));
  hero.append(icon, summary, button('View findings', () => navigate('findings'), 'btn', 'arrow')); root.append(hero);
  const stats = node('div', 'stats');
  for (const [label, value, caption] of [['Conversations', r.counts?.conversations, 'Observed records'], ['Confirmed issues', r.counts?.errors, 'Deterministic findings'], ['Review candidates', r.counts?.warnings, 'Human judgment needed'], ['Informational', r.counts?.info, 'Context and observations']]) { const stat = node('div', 'stat'); stat.append(node('span', 'label', label), node('strong', '', displayCount(value)), node('small', '', caption)); stats.append(stat); }
  root.append(stats);
  const columns = node('div', 'overview-grid'), checks = panel('What was checked'), list = node('div', 'checks-list');
  for (const check of r.checks || []) { const row = node('div', 'check-row'), body = node('div', 'grow'); body.append(node('span', '', check.name || 'Check')); if(check.detail) body.append(node('small', '', check.detail)); row.append(makeIcon(check.status === 'PASS' ? 'check' : 'info'), body, badge(check.status)); list.append(row); }
  if (!r.checks?.length) list.append(empty('No check records', 'This result did not contain check-level details.'));
  checks.append(list);
  const details = panel('Inspection details'), body = node('div', 'panel-body'), c = r.coverage || {};
  body.append(kv('Original baseline', c.hasOriginal ? 'Available' : 'Not available'), kv('Converted JSON', c.hasJson ? 'Available' : 'Not available'), kv('Converted HTML', c.hasHtml ? 'Available' : 'Not available'));
  const profiles = (r.profileCandidates || []).filter(p => typeof p === 'string' || p.mismatchedConversations === 0).map(p => typeof p === 'string' ? p : p.name || p.id || 'Profile');
  body.append(kv('Selected profile', r.profile), kv('Matching profiles', profiles.length ? profiles.join('; ') : 'No matching profile'), kv('Rule version', r.ruleVersion), kv('Retained findings', (r.findings || []).length + ' of ' + (r.counts?.total ?? (r.findings || []).length)));
  const note = node('p', 'note-inline', c.complete ? 'The required inputs were available for comparison.' : 'Coverage is incomplete. Missing inputs and unavailable comparisons remain visible in the check results.'); body.append(note);
  details.append(body); columns.append(checks, details); root.append(columns);
  if (r.limitations?.length) { const limitations = panel('Scope and limitations'), list = node('ul', 'guide-list'); for (const limitation of r.limitations) list.append(node('li', '', text(limitation))); limitations.append(list); root.append(limitations); }
  if (r.files?.length) {
    const files = panel('Inspected files');
    for (const file of r.files) { const item = node('div', 'file-summary'); item.append(node('h3', '', file.name || file.label || file.role || 'Input'), node('p', 'tiny muted', [file.role, bytes(file.bytes ?? file.size), file.records == null ? '' : displayCount(file.records) + ' records'].filter(Boolean).join(' · '))); if(file.sha256) item.append(node('p', 'file-digest mono top-space', 'SHA-256 ' + file.sha256)); files.append(item); }
    root.append(files);
  }
  const actions = node('div', 'row wrap'); actions.append(button('Export report', () => reportDialog(false), 'btn', 'download'));
  if (state.outputAvailable) actions.append(button('Open output folder', () => action(() => api.revealOutput()), 'btn', 'archive'));
  root.append(actions);
}
function severityLabel(value) { return value === 'error' ? 'Confirmed issue' : value === 'warning' ? 'Review candidate' : 'Information'; }
function findings() { const query = $('findingSearch').value.toLowerCase().trim(), severity = $('findingSeverity').value; return (state.result?.findings || []).filter(f => (severity === 'all' || f.severity === severity) && (!query || [f.rule, f.message, f.title, f.conversationId, f.file].some(v => String(v || '').toLowerCase().includes(query)))); }
function renderFindings() {
  const list = $('findingsList'); list.replaceChildren(); const matches = findings();
  $('findingListCount').textContent = state.result ? displayCount(matches.length) + ' findings' : 'No inspection yet';
  if (!matches.length) { list.append(empty(state.result ? 'No matching findings' : 'No inspection yet', state.result ? 'Try another filter, or review the check coverage in Overview.' : 'Run conversion or inspection to see findings.', 'search')); state.selected = null; state.evidence = null; renderEvidence(); return; }
  if (!matches.some(f => f.id === state.selected)) { state.selected = matches[0].id; state.evidence = null; loadEvidence(state.selected); }
  for (const f of matches.slice(0, state.findingLimit)) {
    const item = node('button', 'finding'); item.dataset.finding = f.id; item.setAttribute('aria-pressed', String(f.id === state.selected));
    item.append(badge(f.severity === 'error' ? 'FAIL' : f.severity === 'warning' ? 'REVIEW' : 'LIMITED', severityLabel(f.severity)), node('div', 'rule', f.rule), node('strong', '', f.message), node('p', '', f.title || f.file || 'Archive observation'));
    item.addEventListener('click', () => { state.selected = f.id; state.evidence = null; for(const b of list.querySelectorAll('[data-finding]')) b.setAttribute('aria-pressed', String(b.dataset.finding === f.id)); loadEvidence(f.id); renderEvidence(); }); list.append(item);
  }
  if (matches.length > state.findingLimit) list.append(button('Show more findings', () => { state.findingLimit += 150; renderFindings(); }, 'btn small more-findings'));
  renderEvidence();
}
async function loadEvidence(id) {
  const sequence = ++evidenceSequence;
  try { const result = await api.evidence(id); if(sequence !== evidenceSequence || state.selected !== id) return; state.evidence = result; }
  catch(error) { if(sequence !== evidenceSequence || state.selected !== id) return; state.evidence = { error: error.message || 'Evidence is unavailable.' }; }
  renderEvidence();
}
function renderEvidence() {
  const root = $('findingDetail'); root.replaceChildren();
  const finding = state.result?.findings?.find(f => f.id === state.selected);
  if (!finding) { root.append(empty('Choose a finding', 'The original, expected, and actual values appear here as inert text.', 'search')); return; }
  const head = node('div', 'detail-head'); head.append(badge(finding.severity === 'error' ? 'FAIL' : finding.severity === 'warning' ? 'REVIEW' : 'LIMITED', severityLabel(finding.severity)), node('h2', '', finding.message), node('p', '', [finding.rule, finding.title || finding.file].filter(Boolean).join(' · ')));
  root.append(head, node('div', 'detail-path', finding.pointer || finding.conversationId || 'Archive-level finding'));
  const tabs = node('div', 'evidence-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Evidence view');
  const tabItems = [['actual', 'Actual'], ['expected', 'Expected'], ['source', 'Original'], ['compare', 'Compare']];
  for (const [key, label] of tabItems) { const tab = node('button', '', label); tab.dataset.tab = key; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(state.tab === key)); tab.tabIndex = state.tab === key ? 0 : -1; tab.addEventListener('click', () => { state.tab = key; renderEvidence(); root.querySelector('[data-tab="' + key + '"]').focus(); }); tab.addEventListener('keydown', event => { if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault(); const index = tabItems.findIndex(t => t[0] === state.tab); state.tab = tabItems[event.key === 'Home' ? 0 : event.key === 'End' ? tabItems.length-1 : (index + (event.key === 'ArrowRight' ? 1 : tabItems.length-1)) % tabItems.length][0]; renderEvidence(); root.querySelector('[data-tab="' + state.tab + '"]').focus(); }); tabs.append(tab); }
  root.append(tabs); const body = node('div', 'evidence'); body.setAttribute('role', 'tabpanel'); body.tabIndex = 0;
  if(!state.evidence) body.append(node('p', 'note-inline', 'Loading evidence…'));
  else if(state.evidence.error) body.append(node('p', 'note-inline', state.evidence.error));
  else {
    const keys = state.tab === 'compare' ? ['source','expected','actual'] : [state.tab];
    for(const key of keys) { body.append(node('h3', '', key === 'source' ? 'Original' : key === 'actual' ? 'Actual' : 'Expected')); const value = state.evidence[key] ?? (key === 'source' ? state.evidence.original : undefined); body.append(node('pre', '', text(value, 'No value is available for this observation.'))); }
  }
  root.append(body);
}
function renderSchema() {
  const rows = $('schemaRows'); rows.replaceChildren(); const schema = state.result?.schema;
  $('schemaStatus').textContent = !schema ? 'No inspection yet' : displayCount(schema.changes?.length || 0) + ' schema observations';
  $('baselineLabel').textContent = schema ? 'Baseline: ' + text(schema.baseline, 'bundled reviewed baseline') : 'Compared with the bundled reviewed baseline';
  const changes = new Map((schema?.changes || []).map(c => [c.key, c]));
  const inventory = schema?.inventory || {};
  const items = $('schemaChangesOnly').checked ? [...changes.values()].map(c => ({...c, result: c.kind === 'type' ? 'New type' : 'New field'})) : Object.entries(inventory).map(([key,v]) => ({key, ...v, types: Object.keys(v.types || {}), result: changes.has(key) ? changes.get(key).kind === 'type' ? 'New type' : 'New field' : 'Known'}));
  // Keep huge schema inventories responsive; every observed item remains searchable in JSON reports.
  for (const item of items.slice(0, 2000)) { const row = node('tr'); row.append(node('td', 'mono', item.key), node('td', '', Array.isArray(item.types) ? item.types.join(', ') : Object.keys(item.types || {}).join(', ')), node('td', '', item.result), node('td', '', displayCount(item.count))); rows.append(row); }
  $('schemaEmpty').hidden = items.length > 0;
  if (!items.length) $('schemaEmpty').replaceChildren(makeIcon(schema ? 'check' : 'branch'), node('h3', '', schema ? 'No matching schema changes' : 'No inspection yet'), node('p', '', schema ? 'Switch off Changes only to see the observed inventory.' : 'Run conversion or inspection to examine observed fields and types.'));
  if (items.length > 2000) { const row = node('tr'), cell = node('td', '', 'Showing the first 2,000 entries. The JSON report contains the full observed inventory.'); cell.colSpan = 4; row.append(cell); rows.append(row); }
}
function openModal(title) { modalFocus = document.activeElement; $('modalTitle').textContent = title; $('modalBody').replaceChildren(); $('modalFooter').replaceChildren(); $('modalBackdrop').hidden = false; $('appShell').inert = true; $('closeModal').focus(); }
function closeModal() { $('modalBackdrop').hidden = true; $('appShell').inert = false; if(modalFocus?.isConnected) modalFocus.focus(); }
function reportDialog() {
  if(!state.result) return;
  openModal('Export inspection report');
  const label = node('label', '', 'Report format'), format = node('select', 'field'); format.id = 'reportFormat'; label.htmlFor = format.id;
  for(const [value,name] of [['html','Offline HTML'],['json','JSON'],['csv','CSV']]) { const option = node('option','',name); option.value = value; format.append(option); }
  const warning = node('p','danger-note','Reports contain filenames, conversation identifiers, titles, and findings. Raw conversation evidence is excluded. Review the report before sharing it.');
  $('modalBody').append(label,format,warning);
  const save = button('Save report', async () => { save.disabled = true; try { const result = await api.exportReport({format:format.value, includeEvidence:false}); if(result?.cancelled || result === null || result === false) return; closeModal(); toast('Report saved.'); } catch(error) { warning.textContent = error.message || 'The report could not be saved.'; } finally { save.disabled = false; } }, 'btn primary','download');
  save.id = 'saveReport'; $('modalFooter').append(button('Cancel',closeModal,'btn'),save); format.focus();
}
function showGuide() {
  openModal('Your export, step by step');
  const list = node('ol','guide-list');
  for(const step of [
    'In Convert & validate, choose the original ZIP downloaded from ChatGPT. Select the writing-block conversions you need; email conversion is always included.',
    'Choose a destination folder. Each run creates a new output folder containing the converted JSON, HTML viewer, output bundle, and validation report. Existing files and original exports stay unchanged.',
    'In Inspect existing, select converted JSON or HTML, or a processed ZIP bundle. Add the original export when available so preservation can be checked. A missing baseline limits what can be concluded.',
    'Review Overview first, then investigate Findings. Original, expected, and actual evidence is displayed as text. Input HTML and embedded scripts are never executed by the inspector.',
    'Schema watch highlights fields and types beyond the reviewed baseline. These are review candidates; their presence alone does not prove data loss.',
    'Export an HTML, JSON, or CSV report for your records. Reports include finding locations and conversation metadata, but exclude raw evidence text. Review reports before sharing them, and keep original exports until you have checked the results.'
  ]) list.append(node('li','',step));
  $('modalBody').append(list); $('modalFooter').append(button('Got it',closeModal,'btn primary'));
}
function applyPreferences(preferences = {}) {
  state.theme = ['system','light','dark'].includes(preferences.theme) ? preferences.theme : 'system';
  state.density = preferences.density === 'compact' ? 'compact' : 'comfortable';
  document.documentElement.dataset.theme = state.theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : state.theme;
  document.documentElement.dataset.density = state.density;
  try { localStorage.setItem('processor.appearance',state.theme); } catch {}
  for(const button of document.querySelectorAll('[data-theme-choice]')) button.setAttribute('aria-pressed',String(button.dataset.themeChoice === state.theme));
  $('density').value = state.density; $('themeCycle').setAttribute('aria-label','Change theme; current selection '+state.theme);
}
async function savePreferences(update) {
  const previous = {theme:state.theme,density:state.density}; applyPreferences({...previous,...update});
  try { const saved = await api.setPreferences({theme:state.theme,density:state.density}); if(saved?.preferences) applyPreferences(saved.preferences); else if(saved?.theme) applyPreferences(saved); }
  catch(error) { applyPreferences(previous); showError(error); }
}

fillIcons();
for(const button of document.querySelectorAll('[data-page]')) button.addEventListener('click',()=>navigate(button.dataset.page));
for(const button of document.querySelectorAll('[data-choose]')) button.addEventListener('click',()=>choose(button.dataset.choose));
for(const button of document.querySelectorAll('[data-clear]')) button.addEventListener('click',()=>clearInput(button.dataset.clear));
for(const button of document.querySelectorAll('[data-theme-choice]')) button.addEventListener('click',()=>savePreferences({theme:button.dataset.themeChoice}));
for(const button of document.querySelectorAll('[data-export]')) button.addEventListener('click',()=>reportDialog(button.dataset.export === 'detail'));
$('modeConvert').addEventListener('click',()=>{state.mode='convert';clearError();updateWorkspace();});
$('modeInspect').addEventListener('click',()=>{state.mode='inspect';clearError();updateWorkspace();});
$('inspectSource').addEventListener('change',updateWorkspace);
$('chooseOutput').addEventListener('click',()=>choose('outputDir'));
$('run').addEventListener('click',startRun); $('cancelRun').addEventListener('click',cancelRun);
$('findingSearch').addEventListener('input',()=>{state.findingLimit=150;renderFindings();});
$('findingSeverity').addEventListener('change',()=>{state.findingLimit=150;renderFindings();});
$('schemaChangesOnly').addEventListener('change',renderSchema);
$('headAction').addEventListener('click',()=>reportDialog(false));
$('themeCycle').addEventListener('click',()=>{const choices=['system','light','dark'];savePreferences({theme:choices[(choices.indexOf(state.theme)+1)%choices.length]});});
$('density').addEventListener('change',()=>savePreferences({density:$('density').value}));
$('help').addEventListener('click',showGuide); $('closeModal').addEventListener('click',closeModal);
$('modalBackdrop').addEventListener('click',event=>{if(event.target===$('modalBackdrop'))closeModal();});
document.addEventListener('keydown',event=>{
  if($('modalBackdrop').hidden) return;
  if(event.key==='Escape') {event.preventDefault();closeModal();return;}
  if(event.key==='Tab') {const focusable=[...$('modalBackdrop').querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(x=>!x.hidden); const first=focusable[0],last=focusable.at(-1); if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
});
systemTheme.addEventListener('change',()=>{if(state.theme==='system')applyPreferences({theme:state.theme,density:state.density});});
(async()=>{
  try {
    if(!api) throw new Error('The desktop bridge is unavailable. Open this interface through the installed application.');
    api.onEvent(onEvent);
    const initial = await api.getState(); state.selection=initial.selection||{};state.result=initial.result?.report||initial.result||null;state.running=!!initial.running;state.outputAvailable=initial.outputAvailable===true;
    $('appVersion').textContent=initial.version||'1.0.0';applyPreferences(initial.preferences);renderResult();updateWorkspace();
  } catch(error) { renderResult();updateWorkspace();showError(error); }
  finally { if(api?.ready) await api.ready(); }
})();
