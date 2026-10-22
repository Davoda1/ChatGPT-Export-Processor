/* Offline archive UI. Conversation content is treated exclusively as data. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const pageSize = 10, messageBatch = 60;
  const state = {records: [], filtered: [], page: 0, query: '', branch: 'current', expanded: new Set()};
  const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const renderer = new marked.Renderer();
  renderer.html = token => escape(token.text || token.raw || '');
  renderer.image = token => `<span class="image-placeholder">Image: ${escape(token.text || 'saved media')} — remote content is not loaded</span>`;
  renderer.checkbox = token => token.checked ? '☑ ' : '☐ ';
  const markdown = new marked.Marked({renderer, gfm: true, breaks: false});
  const allowedTags = ['p','br','h1','h2','h3','h4','h5','h6','strong','em','del','s','blockquote','ul','ol','li','hr','pre','code','table','thead','tbody','tr','th','td','a','span','sup','sub'];
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function plainParts(message) {
    const content = message?.content;
    if (typeof content === 'string') return [content];
    if (!content || typeof content !== 'object') return [];
    const parts = Array.isArray(content.parts) ? content.parts : typeof content.text === 'string' ? [content.text] : [];
    return parts.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      if (part && typeof part.transcript === 'string') return part.transcript;
      const type = typeof part?.content_type === 'string' ? part.content_type : 'non-text content';
      return `[${type}: retained in the saved data; not rendered as an external resource]`;
    });
  }
  function allNodes(record) {
    const mapping = record?.mapping;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return [];
    return Object.entries(mapping).filter(([, node]) => node?.message).map(([id, node], index) => ({id, node, index})).sort((a, b) => {
      const first = Number(a.node.message.create_time), second = Number(b.node.message.create_time);
      return Number.isFinite(first) && Number.isFinite(second) && first !== second ? first - second : a.index - b.index;
    });
  }
  function visibleNodes(record) {
    if (state.branch === 'all') return allNodes(record);
    const mapping = record?.mapping;
    if (!mapping || !Object.hasOwn(mapping, record.current_node)) return allNodes(record);
    const nodes = [], visited = new Set();
    let id = record.current_node;
    while (id != null && Object.hasOwn(mapping, id) && !visited.has(id)) {
      visited.add(id);
      const node = mapping[id];
      if (!node || typeof node !== 'object') break;
      if (node.message) nodes.push({id, node});
      id = node.parent;
    }
    return nodes.reverse();
  }
  function renderMarkdown(text) {
    const container = element('div', 'markdown');
    try {
      const fragment = DOMPurify.sanitize(markdown.parse(text), {ALLOWED_TAGS: allowedTags, ALLOWED_ATTR: ['href','title','class','start','colspan','rowspan'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true});
      for (const anchor of fragment.querySelectorAll('a')) {
        let href = null;
        try { const parsed = new URL(anchor.getAttribute('href')); if (['https:', 'http:'].includes(parsed.protocol)) href = parsed.href; } catch { /* Unsupported destinations remain readable text. */ }
        if (href) { anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
        else anchor.removeAttribute('href');
      }
      // Never let exported HTML influence application styles. Only classes added by
      // our Markdown renderer are retained before highlighter output is applied.
      for (const node of fragment.querySelectorAll('[class]')) {
        const language = node.tagName === 'CODE' && /^language-[a-z0-9_+-]{1,40}$/i.test(node.className);
        if (!language && node.className !== 'image-placeholder') node.removeAttribute('class');
      }
      container.append(fragment);
      for (const code of container.querySelectorAll('pre code')) {
        const language = /^language-([a-z0-9_+-]{1,40})$/i.exec(code.className)?.[1];
        if (language && hljs.getLanguage(language) && code.textContent.length < 100000) {
          code.innerHTML = hljs.highlight(code.textContent, {language, ignoreIllegals: true}).value;
          code.classList.add('hljs');
        }
      }
    } catch {
      const fallback = element('pre', '', text);
      container.append(fallback);
    }
    return container;
  }
  function renderMessage(item) {
    const message = item.node.message;
    const role = String(message.author?.role || 'message');
    const block = element('section', 'message ' + (['user','assistant','system','tool'].includes(role) ? role : 'other'));
    block.append(element('div', 'author', role));
    const pieces = plainParts(message);
    if (pieces.length) block.append(renderMarkdown(pieces.join('\n\n')));
    else block.append(element('p', 'message-note', 'No displayable text. Structured content remains in the saved data.'));
    return block;
  }
  function dateText(record) {
    const seconds = Number(record.create_time);
    if (!Number.isFinite(seconds) || seconds <= 0) return 'Saved conversation';
    const date = new Date(seconds * 1000);
    return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, {year:'numeric',month:'short',day:'numeric'}) : 'Saved conversation';
  }
  function conversation(recordIndex) {
    const record = state.records[recordIndex], nodes = visibleNodes(record);
    const card = element('article', 'conversation');
    const button = element('button', 'conversation-head');
    const title = element('span', 'title');
    title.append(element('h2', '', record.title || 'Untitled conversation'), element('small', '', dateText(record)));
    button.append(element('span', 'chevron', '›'), title, element('span', 'count', `${nodes.length} messages`));
    const messages = element('div', 'messages');
    messages.id = `conversation-${recordIndex}`;
    button.setAttribute('aria-controls', messages.id);
    let rendered = 0;
    const more = element('button', 'load-more');
    function loadBatch() {
      more.remove();
      const until = Math.min(nodes.length, rendered + messageBatch);
      while (rendered < until) messages.append(renderMessage(nodes[rendered++]));
      if (rendered < nodes.length) { more.textContent = `Show more messages (${nodes.length - rendered} remaining)`; messages.append(more); }
      if (!nodes.length) messages.append(element('p', 'message-note', 'This conversation has no saved messages.'));
    }
    more.addEventListener('click', loadBatch);
    function update(open) {
      if (open) { state.expanded.add(recordIndex); if (!rendered) loadBatch(); }
      else state.expanded.delete(recordIndex);
      button.setAttribute('aria-expanded', String(open));
      messages.hidden = !open;
    }
    button.addEventListener('click', () => update(!state.expanded.has(recordIndex)));
    update(state.expanded.has(recordIndex));
    card.append(button, messages);
    return card;
  }
  function renderPage() {
    const archive = byId('archive'), totalPages = Math.max(1, Math.ceil(state.filtered.length / pageSize));
    state.page = Math.max(0, Math.min(state.page, totalPages - 1));
    archive.replaceChildren();
    const onPage = state.filtered.slice(state.page * pageSize, (state.page + 1) * pageSize);
    if (!onPage.length) { const empty = element('div', 'empty'); empty.append(element('h2', '', state.query ? 'No matching conversations' : 'No saved conversations'), element('p', '', state.query ? 'Try a different title, phrase, or word.' : 'This archive contains an empty conversation array.')); archive.append(empty); }
    else for (const index of onPage) archive.append(conversation(index));
    byId('summary').textContent = `${state.filtered.length.toLocaleString()} of ${state.records.length.toLocaleString()} conversations${state.query ? ' match your search' : ''}`;
    byId('page-label').textContent = `Page ${state.page + 1} of ${totalPages}`;
    byId('previous').disabled = state.page === 0;
    byId('next').disabled = state.page + 1 >= totalPages;
    byId('expand').disabled = byId('collapse').disabled = !onPage.length;
    archive.scrollTop = 0;
  }
  let searchTimer, searchGeneration = 0;
  byId('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    const generation = ++searchGeneration;
    searchTimer = setTimeout(async () => {
      const query = byId('search').value.trim().toLocaleLowerCase(), filtered = [];
      byId('summary').textContent = 'Searching saved conversations…';
      for (let i = 0; i < state.records.length; i++) {
        const record = state.records[i];
        if (!query || String(record.title || '').toLocaleLowerCase().includes(query) || allNodes(record).some(item => plainParts(item.node.message).some(text => text.toLocaleLowerCase().includes(query)))) filtered.push(i);
        if (query && i % 25 === 24) {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (generation !== searchGeneration) return;
        }
      }
      if (generation !== searchGeneration) return;
      state.query = query;
      state.filtered = filtered;
      state.page = 0;
      renderPage();
    }, 180);
  });
  byId('branch').addEventListener('change', () => { state.branch = byId('branch').value; renderPage(); });
  byId('previous').addEventListener('click', () => { state.page--; renderPage(); });
  byId('next').addEventListener('click', () => { state.page++; renderPage(); });
  byId('expand').addEventListener('click', () => { for (const id of state.filtered.slice(state.page * pageSize, (state.page + 1) * pageSize)) state.expanded.add(id); renderPage(); });
  byId('collapse').addEventListener('click', () => { for (const id of state.filtered.slice(state.page * pageSize, (state.page + 1) * pageSize)) state.expanded.delete(id); renderPage(); });
  const media = matchMedia('(prefers-color-scheme: dark)');
  function theme() { const chosen = byId('theme').value; document.documentElement.dataset.theme = chosen === 'system' ? media.matches ? 'dark' : 'light' : chosen; }
  byId('theme').addEventListener('change', theme); media.addEventListener('change', theme); theme();
  byId('licenses').addEventListener('click', () => {
    const body = byId('license-body');
    if (!body.childElementCount) for (const notice of JSON.parse(byId('license-data').textContent)) body.append(element('h3', '', notice.name), element('pre', '', notice.license));
    byId('license-dialog').showModal();
  });
  byId('close-licenses').addEventListener('click', () => byId('license-dialog').close());
  try {
    const data = byId('archive-data').textContent;
    const prefix = 'var jsonData = ';
    if (!data.startsWith(prefix) || !data.endsWith(';')) throw new Error('Invalid archive data wrapper.');
    const records = JSON.parse(data.slice(prefix.length, -1));
    if (!Array.isArray(records) || records.some(record => !record || typeof record !== 'object' || Array.isArray(record))) throw new Error('The archive must contain conversation objects.');
    state.records = records;
    state.filtered = records.map((_, index) => index);
    if (records.length) state.expanded.add(0);
    renderPage();
  } catch (error) {
    byId('summary').textContent = 'Archive data could not be opened.';
    const warning = element('div', 'empty error');
    warning.append(element('h2', '', 'Unable to display this archive'), element('p', '', String(error.message)));
    byId('archive').replaceChildren(warning);
    for (const id of ['search','branch','previous','next','expand','collapse']) byId(id).disabled = true;
  }
})();
