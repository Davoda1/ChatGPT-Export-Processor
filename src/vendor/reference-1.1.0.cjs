"use strict";
// Immutable in-memory rules from GUI 1.1.0 (MIT); no file writing or conversion entry point.
const START = "\ue200";
const END = "\ue201";
const SEP = "\ue202";
const LINE = "\ue205";
const DROP = "\ue203\ue204\ue206";
const TURN_RE = /\bturn\d+(?:search|news|image|file|product|view|fetch|open|reddit|business)\d+\b/gi;
const TURN_FULL_RE = /^turn\d+(?:search|news|image|file|product|view|fetch|open|reddit|business)\d+$/i;
const REF_RE = /^turn(\d+)(search|news|image|file|product|view|fetch|open|reddit|business)(\d+)$/i;
const EMPTY_LINK_RE = /\[([^\]\n]+)\]\(\)/g;
const HTML_ASSIGNMENT_RE = /(?:var|let|const)\s+jsonData\s*=\s*/m;

function sanitize(value) {
  if (typeof value !== "string") return "";
  let s = value.trim();
  s = s.replace(EMPTY_LINK_RE, "[$1]");
  s = s.replace(TURN_RE, "");
  s = s.replace(/ {2,}/g, " ");
  return s.trim();
}

class Resolver {
  constructor(msg) {
    const refs = msg && msg.metadata && msg.metadata.content_references;
    this.refs = Array.isArray(refs) ? refs : [];
    this.formats = new FormatResolver(msg, this.refs);
    this.cursors = new Map();
    this.internal = new Map();
    for (const r of this.refs) {
      if (!r || typeof r !== "object" || Array.isArray(r)) continue;
      this.scanRefContainer(r, r);
    }
  }

  scanRefContainer(obj, owner) {
    if (Array.isArray(obj)) {
      for (const v of obj) this.scanRefContainer(v, owner);
      return;
    }
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj.refs)) {
      for (const rr of obj.refs) {
        if (!rr || typeof rr !== "object") continue;
        const ti = rr.turn_index;
        const ri = rr.ref_index;
        const rt = rr.ref_type;
        if (Number.isInteger(ti) && Number.isInteger(ri) && typeof rt === "string") {
          const key = `turn${ti}${rt}${ri}`;
          if (!this.internal.has(key)) this.internal.set(key, owner);
        }
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k !== "refs") this.scanRefContainer(v, owner);
    }
  }

  take(...types) {
    const key = types.join("\u0000");
    const start = this.cursors.get(key) || 0;
    for (let i = start; i < this.refs.length; i++) {
      const r = this.refs[i];
      if (r && typeof r === "object" && types.includes(r.type)) {
        this.cursors.set(key, i + 1);
        return r;
      }
    }
    this.cursors.set(key, this.refs.length);
    return null;
  }

  alt(...types) {
    const r = this.take(...types);
    if (r && typeof r === "object") return sanitize(r.alt || r.prompt_text || "");
    return "";
  }

  refAlt(refid) {
    const r = this.internal.get(refid);
    if (!r || typeof r !== "object") return "";
    for (const item of Array.isArray(r.items) ? r.items : []) {
      if (!item || typeof item !== "object") continue;
      for (const rr of Array.isArray(item.refs) ? item.refs : []) {
        if (!rr || typeof rr !== "object") continue;
        const ti = rr.turn_index;
        const ri = rr.ref_index;
        const rt = rr.ref_type;
        if (Number.isInteger(ti) && Number.isInteger(ri) && typeof rt === "string" && `turn${ti}${rt}${ri}` === refid) {
          let title = sanitize(String(item.title || ""));
          const attrib = sanitize(String(item.attribution || ""));
          if (attrib && attrib.includes(".") && title && !title.toLowerCase().startsWith(attrib.toLowerCase() + ":")) {
            title = `${attrib}: ${title}`;
          }
          const url = String(item.url || "").trim();
          if (title && url) return `[${title}](${url})`;
        }
      }
    }
    return sanitize(r.alt || r.prompt_text || "");
  }

  fileLabel(line = "") {
    const r = this.take("file");
    const name = r && typeof r === "object" ? r.name : null;
    if (name) {
      let label = String(name);
      if (line) label += " " + String(line).trim();
      return `[${label}]`;
    }
    if (line) return `[${String(line).trim()}]`;
    return "[file citation]";
  }
}

function jload(s) {
  try { return JSON.parse(s); }
  catch (_) {
    try { return JSON.parse(String(s).replace(/\\"/g, '"')); }
    catch (_) { return null; }
  }
}

function usefulStrings(obj) {
  const out = [];
  function rec(x) {
    if (typeof x === "string") {
      const t = x.trim();
      if (t && !TURN_FULL_RE.test(t)) out.push(t);
      return;
    }
    if (Array.isArray(x)) {
      for (const v of x) rec(v);
      return;
    }
    if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x)) {
        if (!new Set(["ref", "ref_id", "cite", "merchant_reference_id", "image_reference_id"]).has(k)) rec(v);
      }
    }
  }
  rec(obj);
  return out.filter(Boolean);
}

function jsonPrettyOne(obj) {
  return JSON.stringify(obj, null, 1);
}

// Format-compatibility handlers. Read exported literals only; never execute widgets.
function formatRecord(x) { return x !== null && typeof x === "object" && !Array.isArray(x); }
function formatList(x) { return Array.isArray(x) ? x : []; }
function formatScalar(x) { return typeof x === "string" ? x.trim() : typeof x === "number" && Number.isFinite(x) ? String(x) : ""; }
function formatText(x) {
  return formatScalar(x).replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\\/g, "\\\\").replace(/([`*_[\]<>!])/g, "\\$1").replace(/\|/g, "&#124;");
}
function formatUrl(x) {
  if (typeof x !== "string" || /[\x00-\x1f\x7f\\]/.test(x)) return "";
  const value = x.trim();
  if (!/^https?:\/\//i.test(value)) return "";
  try { const u = new URL(value); if (!u.hostname || u.username || u.password) return ""; }
  catch (_) { return ""; }
  return value;
}
function formatLink(label, url) {
  const safe = formatUrl(url), text = formatText(label) || (safe ? formatText(new URL(safe).hostname) : "");
  if (!safe) return text;
  const dest = safe.replace(/[\s()<>"|`]/g, ch => encodeURIComponent(ch).replace(/[()]/g, c => c === "(" ? "%28" : "%29"));
  return `[${text}](${dest})`;
}
function formatRefIds(value) {
  const out = [];
  for (const ref of formatList(value)) {
    const id = typeof ref === "string" ? ref : formatRecord(ref) && Number.isInteger(ref.turn_index) && ref.turn_index >= 0 && Number.isInteger(ref.ref_index) && ref.ref_index >= 0 && typeof ref.ref_type === "string" ? `turn${ref.turn_index}${ref.ref_type}${ref.ref_index}` : "";
    if (REF_RE.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
function formatSameIds(a, b) { return a.length === b.length && a.every(id => b.includes(id)); }
function formatMarkers(content) {
  const out = [];
  function visit(value) {
    if (typeof value === "string") {
      const re = /\ue200([^\ue200\ue201]*)\ue201/g; let match;
      while ((match = re.exec(value))) {
        const [name, ...args] = match[1].split(SEP);
        if (name.trim().toLowerCase() === "genui") out.push({text: value, start: match.index, marker: match[0], payload: args[0] || ""});
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (formatRecord(value)) Object.values(value).forEach(visit);
  }
  visit(content); return out;
}
// Parse a small Markdown link list, not arbitrary HTML or Markdown from metadata.
function formatAltLinks(alt) {
  if (typeof alt !== "string" || alt.length > 65536) return [];
  const result = []; let i = 0;
  while (i < alt.length) {
    if (/[\s(),]/.test(alt[i])) { i++; continue; }
    if (alt[i++] !== "[") return [];
    let label = "", closed = false;
    while (i < alt.length) {
      const c = alt[i++];
      if (c === "\\" && i < alt.length) label += alt[i++];
      else if (c === "]") { closed = true; break; }
      else label += c;
    }
    if (!closed || alt[i++] !== "(") return [];
    let url = "", depth = 1;
    while (i < alt.length && depth) {
      const c = alt[i++];
      if (c === "\\" && i < alt.length) url += alt[i++];
      else if (c === "(") { depth++; url += c; }
      else if (c === ")") { if (--depth) url += c; }
      else url += c;
    }
    if (depth || !formatUrl(url) || !label.trim()) return [];
    result.push({label, url});
  }
  return result;
}

class FormatResolver {
  constructor(msg, refs) {
    this.groups = []; this.products = []; this.widgets = []; this.bindings = []; this.images = [];
    const markers = formatMarkers(msg && msg.content);
    const genuiRefs = [];
    const states = msg && msg.metadata && msg.metadata.view_state && msg.metadata.view_state.widgets;
    refs.forEach((r, index) => {
      if (!formatRecord(r)) return;
      if (r.prefix === "genui") genuiRefs.push({r, index});
      if (r.type === "grouped_webpages" && (!r.prefix || r.prefix === "genui")) {
        const items = formatList(r.items).filter(formatRecord).map(item => ({
          ids: formatRefIds(item.refs),
          links: [item, ...formatList(item.supporting_websites)].filter(formatRecord).map(x => ({url: formatUrl(x.url), label: formatScalar(x.title) || formatScalar(x.attribution)})).filter(x => x.url)
        }));
        this.groups.push({ids: [...new Set(items.flatMap(x => x.ids))], items, alt: formatAltLinks(r.alt)});
      }
      if (["image_group", "image_inline", "image_v2"].includes(r.type)) {
        this.images.push({index, ids: formatRefIds(r.refs || r.image_refs), links: formatAltLinks(typeof r.alt === "string" ? r.alt.replace(/!\[/g, "[") : "")});
      }
      if (["product", "product_entity", "products"].includes(r.type)) {
        for (const item of [r, ...formatList(r.products)]) {
          if (!formatRecord(item)) continue;
          const prompt = typeof item.prompt_text === "string" ? item.prompt_text : "";
          const title = formatScalar(item.product_name || item.name || item.title) || (/^###\s+([^\n]+)(?:\n|$)/.exec(prompt) || [])[1] || "";
          const fields = {};
          for (const line of prompt.split(/\r?\n/)) {
            const match = /^(Description|Price|URL|Merchants):\s*(.*)$/.exec(line);
            if (match && !/^(?:None|null|undefined|N\/A)$/i.test(match[2].trim())) fields[match[1]] = match[2].trim();
          }
          if (title) this.products.push({title, id: item.cite || item.ref || item.ref_id, description: formatScalar(item.description) || fields.Description || "", merchant: formatScalar(item.merchant_name || item.merchants) || fields.Merchants || "", price: formatScalar(item.price) || fields.Price || "", currency: formatScalar(item.currency), url: formatUrl(item.url) || formatUrl(fields.URL)});
        }
      }
      if (r.prefix === "genui" && ["client_defined_widget", "map_widget", "dil"].includes(r.type)) {
        const state = formatRecord(states) && formatRecord(states[`${msg.id}:${index}`]) ? states[`${msg.id}:${index}`] : null;
        // Snapshot just the literal fields that we use, before metadata cleanup.
        const points = formatList(state && state.points).filter(formatRecord).map(p => ({ids: formatRefIds(p.refs).concat(formatRefIds([p.ref])), name: formatScalar(p.name), category: formatScalar(p.category), address: formatScalar(p.address) || formatScalar(p.entity && p.entity.address), url: formatUrl(p.url) || formatUrl(p.entity && p.entity.website_url)}));
        const initial = formatRecord(r.dil) && formatRecord(r.dil.initialState) ? r.dil.initialState : {};
        const literalState = x => Object.fromEntries(["from_currency", "to_currency", "base_amount", "converted_amount", "exchange_rate", "as_of"].filter(k => x && Object.prototype.hasOwnProperty.call(x, k)).map(k => [k, typeof x[k] === "string" || typeof x[k] === "number" ? x[k] : null]));
        this.widgets.push({index, type: r.type, name: r.name, points, state: state ? literalState(state) : null, initial: literalState(initial)});
      }
    });
    // In exports without offsets, the ordered prefix records identify the opaque
    // widget. Require a complete one-to-one match; never take an arbitrary DIL.
    if (markers.length === genuiRefs.length) {
      markers.forEach((m, i) => {
        const {r, index} = genuiRefs[i], obj = jload(m.payload);
        const valid = formatRecord(obj) ?
          (obj.citation && r.type === "grouped_webpages") || (obj.map_widget && ["client_defined_widget", "map_widget"].includes(r.type)) || (!obj.citation && !obj.map_widget && r.type !== "dil") : r.type === "dil" && /^[A-Za-z0-9_-]{1,128}$/.test(m.payload);
        if (valid) this.bindings.push({...m, index});
      });
    }
  }
  boundIndex(context) {
    if (!context) return null;
    const matches = this.bindings.filter(x => x.text === context.text && x.start === context.start && x.marker === context.marker);
    if (matches.length !== 1) return null;
    return matches[0].index;
  }
  boundWidget(context) {
    const index = this.boundIndex(context);
    return this.widgets.find(w => w.index === index) || null;
  }
  imagesFor(ids, context) {
    const index = this.boundIndex(context);
    const matches = this.images.filter(g => formatSameIds(g.ids, ids) || g.index === index);
    if (matches.length !== 1) return "";
    return matches[0].links.map(l => "!" + formatLink(l.label,l.url)).join("\n");
  }
  citation(citation) {
    if (!formatRecord(citation)) return "";
    const ids = formatRefIds(Array.isArray(citation.refs) ? citation.refs : [citation.ref]);
    if (!ids.length) return "";
    let groups = this.groups.filter(g => formatSameIds(g.ids, ids));
    if (!groups.length) groups = this.groups.filter(g => g.ids.length && g.ids.every(id => ids.includes(id))).sort((a,b) => Math.min(...a.ids.map(id => ids.indexOf(id))) - Math.min(...b.ids.map(id => ids.indexOf(id))));
    const links = [], seen = new Set();
    function add(link) { if (!seen.has(link.url)) { seen.add(link.url); links.push(formatLink(TURN_FULL_RE.test(link.label || "") ? "" : link.label, link.url)); } }
    for (const g of groups) {
      const supported = g.items.flatMap(item => item.links);
      if (g.alt.length && g.alt.every(a => supported.some(s => s.url === a.url))) g.alt.forEach(add);
      supported.forEach(add);
    }
    // A partial citation may still have a separately identified item in a larger group.
    for (const id of ids.filter(id => !groups.some(g => g.ids.includes(id)))) for (const g of this.groups) for (const item of g.items) if (item.ids.length === 1 && item.ids[0] === id) item.links.forEach(add);
    return links.join(", ");
  }
  product(obj) {
    const name = formatScalar(obj[1]);
    if (!name || TURN_FULL_RE.test(name)) return "";
    const options = formatRecord(obj[2]) ? obj[2] : {};
    const matches = this.products.filter(p => p.id ? p.id === obj[0] : p.title === name);
    const p = matches.length && matches.every(x => JSON.stringify({...x,id:null}) === JSON.stringify({...matches[0],id:null})) ? matches[0] : {};
    const bits = [`**${p.url ? formatLink(name,p.url) : formatText(name)}**`];
    const description = formatScalar(options.description) || formatScalar(obj[2]) || p.description;
    if (description) bits.push(formatText(description));
    if (p.merchant) bits.push(formatText(p.merchant));
    if (p.price) bits.push(formatText(p.price) + (p.currency && !p.price.includes(p.currency) ? " " + formatText(p.currency) : ""));
    return bits.join(" — ");
  }
  map(map, context) {
    const points = formatList(map && map.points).filter(formatRecord);
    const ids = points.flatMap(p => formatRefIds([p.ref]));
    const candidates = this.widgets.filter(w => w.points.length && ids.length && ids.every(id => w.points.some(p => p.ids.includes(id))));
    const bound = this.boundWidget(context);
    const widget = bound && candidates.includes(bound) ? bound : candidates.length === 1 ? candidates[0] : null;
    const lines = points.map(point => {
      const found = widget ? widget.points.filter(p => p.ids.includes(point.ref)) : [];
      const p = found.length === 1 ? found[0] : {};
      const name = formatScalar(point.name) || p.name, category = formatScalar(point.category) || p.category;
      const address = formatScalar(point.address) || p.address, url = formatUrl(point.url) || p.url;
      const bits = [];
      if (name) bits.push(`**${url ? formatLink(name,url) : formatText(name)}**`);
      if (category) bits.push(formatText(category));
      if (address) bits.push(formatText(address));
      return bits.length ? "- " + bits.join(" — ") : "";
    }).filter(Boolean);
    return lines.length ? "\n\n" + lines.join("\n") + "\n\n" : "[No saved map locations.]";
  }
  currency(context) {
    const widget = this.boundWidget(context);
    if (!widget || widget.type !== "dil" || widget.name !== "currency_converter_widget_with_source") return null;
    const initial = widget.initial, saved = widget.state;
    const samePair = !saved || ["from_currency", "to_currency"].every(k => !Object.prototype.hasOwnProperty.call(saved,k) || saved[k] === initial[k]);
    const state = {...(samePair ? initial : {}), ...(saved || {})};
    const number = x => typeof x === "number" && Number.isFinite(x) ? String(x) : typeof x === "string" && /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(x) && Number.isFinite(Number(x)) ? x : "";
    const from = state.from_currency, to = state.to_currency;
    if (!/^[A-Z]{3}$/.test(from || "") || !/^[A-Z]{3}$/.test(to || "")) return "[Saved currency-converter snapshot unavailable.]";
    const base = number(state.base_amount), converted = number(state.converted_amount), rate = number(state.exchange_rate);
    let text = base && converted ? `${base} ${from} = ${converted} ${to}` : rate ? `1 ${from} = ${rate} ${to}` : "";
    if (!text) return "[Saved currency-converter snapshot unavailable.]";
    if (base && converted && rate && base !== "1") text += `; recorded rate: 1 ${from} = ${rate} ${to}`;
    const asOf = formatText(state.as_of);
    return `Saved currency-converter snapshot: ${text} (${asOf ? `as of ${asOf}; ` : ""}not a live rate).`;
  }
}

function formatChart(wrapper) {
  const c = formatRecord(wrapper) && formatRecord(wrapper.content) ? wrapper.content : {};
  const meta = formatRecord(c.meta) ? c.meta : {}, rows = formatList(c.data).filter(formatRecord);
  const key = formatScalar(c.nameKey || c.xKey), series = formatList(c.series).filter(s => formatRecord(s) && formatScalar(s.dataKey));
  if (!series.length && formatScalar(c.valueKey)) series.push({dataKey:c.valueKey,label:c.valueLabel || c.valueKey,valueSuffix:c.valueSuffix});
  const blocks = [], title = formatText(meta.title || c.title), description = formatText(meta.description || c.description);
  if (title) blocks.push(`**${title}**`);
  if (description) blocks.push(description);
  const label = formatScalar(c.nameLabel || c.xLabel || (c.xAxis && c.xAxis.label)) || (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Category");
  if (key && series.length && rows.length) {
    const header = [label, ...series.map(s => s.label || s.dataKey)].map(formatText);
    const table = ["| " + header.join(" | ") + " |", "| --- | " + series.map(()=>"---:").join(" | ") + " |"];
    for (const row of rows) table.push("| " + [formatText(row[key]), ...series.map(s => {
      const value = formatScalar(row[s.dataKey]);
      return value === "" ? "" : formatText((formatScalar(s.valuePrefix) || "") + value + (formatScalar(s.valueSuffix) || (s.unit ? " " + formatScalar(s.unit) : "")));
    })].join(" | ") + " |");
    blocks.push(table.join("\n"));
  } else blocks.push("[No saved chart data.]");
  for (const note of [meta.footer,meta.footnote,meta.source,c.footer,c.footnote,c.source,...formatList(meta.notes),...formatList(c.notes),typeof meta.notes === "string" ? meta.notes : "",typeof c.notes === "string" ? c.notes : ""]) {
    const text = formatText(note); if (text && !blocks.includes(text)) blocks.push(text);
  }
  return "\n\n" + blocks.join("\n\n") + "\n\n";
}

function formatMarker(name, args, resolver, context) {
  if (name === "url") return formatLink(args[0], args[1]);
  if (name === "visualize") {
    const obj = jload(args[0]);
    if (formatRecord(obj) && typeof obj.path === "string") return "[Interactive visualization not included in this export.]";
    return null;
  }
  if (name === "product") {
    const obj = jload(args[0]);
    if (Array.isArray(obj)) return (resolver || new FormatResolver(null,[])).product(obj);
    return null;
  }
  if (name !== "genui") return null;
  const obj = jload(args[0]);
  if (!formatRecord(obj)) return resolver ? resolver.currency(context) : null;
  if (Object.prototype.hasOwnProperty.call(obj,"citation")) return resolver ? resolver.citation(obj.citation) : "";
  if (Object.keys(obj).every(k => k === "refs") && Array.isArray(obj.refs) && obj.refs.every(r => typeof r === "string" && /^turn\d+image\d+$/.test(r))) return resolver ? resolver.imagesFor(formatRefIds(obj.refs), context) : "";
  if (Object.prototype.hasOwnProperty.call(obj,"charts_widget_v2")) return formatChart(obj.charts_widget_v2);
  if (Object.prototype.hasOwnProperty.call(obj,"chart")) return formatChart(obj.chart);
  if (Object.prototype.hasOwnProperty.call(obj,"suggest_automation")) {
    const label = formatText(obj.suggest_automation && obj.suggest_automation.label);
    return label ? `Suggested reminder: ${label}` : "";
  }
  if (Object.prototype.hasOwnProperty.call(obj,"map_widget")) return (resolver || new FormatResolver(null,[])).map(obj.map_widget, context);
  return null;
}

function markerRepl(name, args, res, context = null) {
  const n = String(name || "").trim().toLowerCase();
  const formatted = formatMarker(n, args, res && res.formats, context);
  if (formatted !== null) return formatted;
  if (n === "cite" || n === "memcite" || n.startsWith("cite…") || n === "cite...") return "";
  if (n === "filecite") {
    const line = args.find(a => /^L\d+(?:-L?\d+)?$/i.test(a || "")) || "";
    return res ? res.fileLabel(line) : `[${line || "file citation"}]`;
  }
  if (n === "entity" || n === "entity_metadata") {
    const obj = args.length ? jload(args[0]) : null;
    let val = "";
    if (Array.isArray(obj) && obj.length > 1 && typeof obj[1] === "string") val = obj[1];
    else if (obj && typeof obj === "object" && !Array.isArray(obj)) val = obj.name || obj.title || "";
    if (!val && args.length) val = args[0];
    val = sanitize(String(val));
    return val ? `*${val}*` : "";
  }
  if (n === "product_entity") {
    const alt = res ? res.alt("product_entity") : "";
    if (alt) return alt;
    const obj = args.length ? jload(args[0]) : null;
    let val = Array.isArray(obj) && obj.length > 1 ? obj[1] : "";
    val = sanitize(String(val || ""));
    return val ? `**${val}**` : "[product]";
  }
  if (n === "products") {
    const obj = args.length ? jload(args[0]) : null;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const sels = Array.isArray(obj.selections) ? obj.selections : [];
      const tags = Array.isArray(obj.tags) ? obj.tags : [];
      const lines = [];
      for (let i = 0; i < sels.length; i++) {
        const sel = sels[i];
        let pname = "";
        if (Array.isArray(sel) && sel.length > 1) pname = sel[1];
        else if (typeof sel === "string") pname = sel;
        pname = sanitize(String(pname || ""));
        if (!pname) continue;
        const tag = i < tags.length && tags[i] ? sanitize(String(tags[i])) : "";
        lines.push(`- **${pname}**${tag ? ` (${tag})` : ""}`);
      }
      if (lines.length) return lines.join("\n");
    }
    let raw = args.length ? args[0] : "";
    raw = String(raw).replace(TURN_RE, "").trim().replace(/\]\s+,/g, "],");
    return raw ? `\`\`\`json\n${raw}\n\`\`\`` : "[products]";
  }
  if (n === "product") {
    let raw = args.length ? args[0] : "";
    const obj = jload(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const pname = sanitize(String(obj.product_name || obj.name || ""));
      const merchant = sanitize(String(obj.merchant_name || ""));
      const price = sanitize(String(obj.price || ""));
      const bits = [];
      if (pname) bits.push(`**${pname}**`);
      if (merchant) bits.push(merchant);
      if (price) bits.push(price);
      if (bits.length) return bits.join(" — ");
    }
    raw = String(raw).replace(TURN_RE, "").trim();
    return raw ? `\`\`\`json\n${raw}\n\`\`\`` : "[product]";
  }
  if (["image_group", "imagegroup", "image", "images"].includes(n)) {
    let alt = "";
    if (res) alt = ["image_group", "imagegroup"].includes(n) ? res.alt("image_group") : res.alt("image_inline", "image_group");
    if (alt) return alt;
    const obj = args.length ? jload(args[0]) : null;
    let queries = [];
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const q = obj.query || obj.queries;
      if (typeof q === "string") queries = [q];
      else if (Array.isArray(q)) queries = q.filter(v => ["string", "number"].includes(typeof v)).map(String);
    }
    if (queries.length) return queries.map(q => sanitize(q)).filter(Boolean).map(q => `*${q}*`).join(", ");
    return "[image]";
  }
  if (n === "i") {
    let alt = res ? res.alt("image_v2") : "";
    if (!alt && res) alt = res.alt("image_group");
    return alt || "[image]";
  }
  if (n === "video") {
    const alt = res ? res.alt("video") : "";
    if (alt) return alt;
    return `[${args.length ? sanitize(args[0]) : "video"}]`;
  }
  if (n === "link_title") {
    const alt = res ? res.alt("link_title") : "";
    if (alt) return alt;
    return `[${args.length ? sanitize(args[0]) : "link"}]`;
  }
  if (n === "link") {
    const ref = args.length ? args[0] : "";
    const alt = res ? res.refAlt(ref) : "";
    return alt || "[link]";
  }
  if (n === "navlist") {
    const title = args.length ? sanitize(args[0]) : "";
    const alt = res ? res.alt("nav_list") : "";
    if (title && alt) return `**${title}**\n${alt}`;
    return alt || (title ? `**${title}**` : "[links]");
  }
  if (n === "businesses_map") {
    const alt = res ? res.alt("businesses_map") : "";
    if (alt) return alt;
    const lines = [];
    for (const arg of args) {
      const o = jload(arg);
      if (o && typeof o === "object" && !Array.isArray(o)) {
        const nm = sanitize(String(o.name || ""));
        const loc = sanitize(String(o.location || ""));
        const desc = sanitize(String(o.description || ""));
        if (nm) lines.push(`**${nm}**${loc ? ` — ${loc}` : ""}${desc ? `\n${desc}` : ""}`);
      }
    }
    return lines.length ? lines.join("\n\n") : "[map]";
  }
  if (n === "map") {
    const alt = res ? res.alt("map") : "";
    return alt || "[map]";
  }
  if (n === "genui") {
    const obj = args.length ? jload(args[0]) : null;
    if (obj !== null) {
      let lines = jsonPrettyOne(obj).split("\n");
      if (lines.length > 2) lines = [lines[0], ...lines.slice(1, -1).map(x => " " + x.trimStart()), lines[lines.length - 1]];
      return `\`\`\`json\n${lines.join("\n")}\n\`\`\``;
    }
    return "[interactive widget]";
  }
  if (["finance", "schedule", "standing", "forecast"].includes(n)) {
    const obj = args.length ? jload(args[0]) : null;
    if (obj !== null) return `\`\`\`json\n${jsonPrettyOne(obj)}\n\`\`\``;
    return `[${n}]`;
  }
  if (n === "..." || n === "…") return "";
  if (n.endsWith("…") || n.endsWith("...")) return `[${String(name).trim()}]`;

  const vals = [];
  for (const a of args) {
    const o = jload(a);
    if (o !== null) vals.push(...usefulStrings(o));
    else if (a && !TURN_FULL_RE.test(a.trim())) vals.push(a);
  }
  const cleaned = vals.map(sanitize).filter(Boolean);
  return cleaned.length ? cleaned.join(", ") : (String(name || "").trim() || "");
}

function transformText(s, res = null) {
  if (typeof s !== "string" || ![START, "\ue203", "\ue204", "\ue205", "\ue206"].some(ch => s.includes(ch))) return s;
  const out = [];
  let i = 0;
  const seenEntities = [];
  while (i < s.length) {
    const j = s.indexOf(START, i);
    if (j < 0) { out.push(s.slice(i)); break; }
    out.push(s.slice(i, j));
    const end = s.indexOf(END, j + 1);
    const nest = s.indexOf(START, j + 1);
    if (end < 0 || (nest >= 0 && nest < end)) { i = j + 1; continue; }
    const inner = s.slice(j + 1, end).split(LINE).join(SEP);
    const parts = inner.split(SEP);
    const name = parts.length ? parts[0] : "";
    const args = parts.slice(1);
    const lname = name.trim().toLowerCase();
    if (lname === "entity") {
      const obj = args.length ? jload(args[0]) : null;
      let val = Array.isArray(obj) && obj.length > 1 && typeof obj[1] === "string" ? obj[1] : "";
      val = sanitize(String(val));
      if (val && !seenEntities.includes(val)) seenEntities.push(val);
    }
    if (lname === "map" && seenEntities.length) out.push("**Map entities:** " + seenEntities.map(x => `*${x}*`).join(", "));
    else out.push(markerRepl(name, args, res, {text: s, start: j, marker: s.slice(j, end + 1)}));
    i = end + 1;
  }
  let r = out.join("");
  for (const ch of START + END + SEP + LINE + DROP) r = r.split(ch).join("");
  return r;
}

function decodeWritingAttr(v) {
  if (!v.includes("\\")) return v;
  let out = "";
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== "\\" || i + 1 >= v.length) { out += v[i]; continue; }
    const n = v[++i];
    const simple = {"n":"\n","r":"\r","t":"\t","b":"\b","f":"\f","\\":"\\",'"':'"',"}":"}"};
    if (Object.prototype.hasOwnProperty.call(simple, n)) { out += simple[n]; continue; }
    if (n === "u" && /^[0-9a-fA-F]{4}$/.test(v.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(v.slice(i + 1, i + 5), 16)); i += 4; continue;
    }
    if (n === "x" && /^[0-9a-fA-F]{2}$/.test(v.slice(i + 1, i + 3))) {
      out += String.fromCharCode(parseInt(v.slice(i + 1, i + 3), 16)); i += 2; continue;
    }
    out += n;
  }
  return out;
}

function writingAttrs(meta) {
  const d = {};
  const re = /(\w+)="((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = re.exec(meta)) !== null) d[m[1]] = decodeWritingAttr(m[2]);
  return d;
}

function fenceFor(body) {
  let mx = 0;
  for (const m of body.matchAll(/`+/g)) mx = Math.max(mx, m[0].length);
  return "`".repeat(Math.max(3, mx + 1));
}

function convertOneBlock(meta, body, enabled) {
  const a = writingAttrs(meta);
  const variant = a.variant || "standard";
  if (!enabled.has(variant)) return null;
  if (variant === "email") {
    const subject = a.subject || "";
    const f = fenceFor(body);
    return `**SUBJECT**: ${subject}\n\n**E-Mail Body**:\n\n${f}markdown\n${body}${body.endsWith("\n") ? "" : "\n"}${f}`;
  }
  if (variant === "standard" || variant === "chat_message") {
    const ident = a.id || "";
    const head = `::: **${variant}** block${ident ? ` id="${ident}"` : ""}`;
    const quoted = body.split(/\r?\n/).map(line => line ? `> ${line}` : ">").join("\n");
    return `${head}\n${quoted}`;
  }
  if (variant === "document") {
    const title = a.title || "";
    return `**TITLE**: ${title}\n${body}${body.endsWith("\n") ? "" : "\n"}**END OF DOCUMENT**`;
  }
  return null;
}

function transformWriting(s, enabled) {
  if (typeof s !== "string" || !s.includes(":::writing{")) return s;
  const openRe = /^:::writing\{([^\n}]*)\}[ \t]*\r?$/gm;
  const closeRe = /^:::[ \t]*\r?$/gm;
  const out = [];
  let pos = 0;
  while (true) {
    openRe.lastIndex = pos;
    const m = openRe.exec(s);
    if (!m) { out.push(s.slice(pos)); break; }
    closeRe.lastIndex = openRe.lastIndex;
    const close = closeRe.exec(s);
    if (!close) { out.push(s.slice(pos)); break; }
    out.push(s.slice(pos, m.index));
    let body = s.slice(openRe.lastIndex, close.index);
    if (body.startsWith("\r\n")) body = body.slice(2);
    else if (body.startsWith("\n")) body = body.slice(1);
    if (body.endsWith("\r\n")) body = body.slice(0, -2);
    else if (body.endsWith("\n")) body = body.slice(0, -1);
    const repl = convertOneBlock(m[1], body, enabled);
    out.push(repl === null ? s.slice(m.index, closeRe.lastIndex) : repl);
    pos = closeRe.lastIndex;
  }
  return out.join("");
}

function transformRecursive(x, useRes, res, enabled, counter) {
  if (typeof x === "string") {
    let y = transformText(x, useRes ? res : null);
    y = transformWriting(y, enabled);
    if (y !== x) counter.changedStrings++;
    return y;
  }
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) x[i] = transformRecursive(x[i], useRes, res, enabled, counter);
    return x;
  }
  if (x && typeof x === "object") {
    for (const k of Object.keys(x)) x[k] = transformRecursive(x[k], useRes, res, enabled, counter);
    return x;
  }
  return x;
}

function transformObj(c, enabled) {
  const counter = {changedStrings: 0};
  const mapping = c && typeof c === "object" && !Array.isArray(c) ? c.mapping : null;
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return counter;
  for (const node of Object.values(mapping)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const msg = node.message;
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    const role = msg.author && msg.author.role;
    const res = new Resolver(msg);
    if (role !== "user" && Object.prototype.hasOwnProperty.call(msg, "content")) {
      msg.content = transformRecursive(msg.content, true, res, enabled, counter);
    }
    for (const k of Object.keys(msg)) {
      if (k === "content" || k === "author") continue;
      msg[k] = transformRecursive(msg[k], false, res, enabled, counter);
    }
  }
  return counter;
}

function enabledSet(opts) {
  const s = new Set(["email"]);
  if (opts.allWritingBlocks) {
    s.add("standard"); s.add("document"); s.add("chat_message");
  } else {
    if (opts.standard) s.add("standard");
    if (opts.document) s.add("document");
    if (opts.chatMessage) s.add("chat_message");
  }
  return s;
}


module.exports={transformObj,enabledSet,Resolver,markerRepl,transformText,transformWriting};
