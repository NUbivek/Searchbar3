/**
 * Investment memo export for a deal workspace.
 *
 * buildMemo() assembles what the workspace already contains (search
 * summaries, notes, saved sources, data-room documents) into one structured
 * memo. Nothing is generated: every line is taken from the workspace, citations
 * are renumbered into one global Sources list (deduped by URL), and each fact
 * line carries a date (the cited source's date where known, otherwise the date
 * the search was run / the note was written).
 *
 * memoToMarkdown() and memoToDocx() render that structure.
 */
import { Document, Packer, Paragraph, HeadingLevel, TextRun, ExternalHyperlink } from 'docx';

const SECTION_KEYS = {
  summary: /^(executive\s+)?summary$/i,
  keyPoints: /^key\s+(points|findings|takeaways)$/i,
  detailed: /^detailed\s+analysis$/i,
  perspectives: /^different\s+perspectives$/i,
  followUp: /^follow[-\s]?up\s+questions$/i,
};

const MAX_EXEC_SUMMARIES = 3;

// Lines that are presentation boilerplate, not facts.
const BOILERPLATE = [
  /^the sources contain no further detail/i,
  /^\*?results synthesized from/i,
  /^\*?note:/i,
  /^for most accurate information/i,
];

// ---------- small helpers ----------

/** YYYY-MM-DD for anything Date can parse; the raw string otherwise; null if empty. */
export function formatDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 40);
  return d.toISOString().slice(0, 10);
}

function normalizeUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    u.hash = '';
    let out = `${u.protocol}//${u.host.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    return out.toLowerCase();
  } catch {
    return s.toLowerCase().replace(/\/+$/, '');
  }
}

const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};

const dedupeKey = (text) => String(text || '')
  .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '')
  .replace(/\(([^()]*\d{4}-\d{2}-\d{2}[^()]*)\)/g, '')
  .replace(/[*_`]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim()
  .toLowerCase();

/** Split a search summary (markdown) into its known sections: {key: [lines]}. */
export function parseSummarySections(markdown) {
  const out = {};
  let current = null;
  for (const raw of String(markdown || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { current = null; continue; } // footer separator
    const headingText = line
      .replace(/^#{1,6}\s*/, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/^\*\*(.+?)\*\*:?$/, '$1')
      .replace(/:$/, '')
      .trim();
    const isHeadingShape = /^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*:?$/.test(line) || /^(\d+[.)]\s*)?[A-Z][A-Z\s-]+:?$/.test(line);
    const key = isHeadingShape ? Object.keys(SECTION_KEYS).find((k) => SECTION_KEYS[k].test(headingText)) : null;
    if (key) { current = key; out[key] = out[key] || []; continue; }
    if (isHeadingShape && /^#{1,2}\s/.test(line)) { current = null; continue; } // unknown top-level section
    if (current) out[current].push(raw);
  }
  return out;
}

/** Turn section lines into blocks: bullets, paragraphs (consecutive lines joined) and subheadings. */
function linesToBlocks(lines) {
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'paragraph', text: para.join(' ').trim() });
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (BOILERPLATE.some((re) => re.test(line))) { flush(); continue; }
    const sub = line.match(/^#{3,6}\s+(.+)$/);
    if (sub) { flush(); blocks.push({ type: 'subheading', text: sub[1].replace(/\*\*/g, '').trim() }); continue; }
    const bullet = line.match(/^(?:[•\-*·▪◦]|\d+[.)])\s+(.+)$/);
    if (bullet) { flush(); blocks.push({ type: 'bullet', text: bullet[1].trim() }); continue; }
    para.push(line);
  }
  flush();
  return blocks.filter((b) => b.text);
}

// Citations: [Source 3], [Sources 1, 3], [Source 1, Source 2], [1], [1, 2]. Not markdown links "[1](...)".
const CITE_RE = /\[\s*(?:sources?\s*)?(\d+(?:\s*(?:,|;|&|and)\s*(?:sources?\s*)?\d+)*)\s*\](?!\()/gi;

/**
 * Global source registry: one numbered list, deduped by URL (title when there is no URL).
 */
function createRegistry() {
  const list = [];
  const byKey = new Map();
  const add = ({ title, url, sourceName, date }) => {
    const key = normalizeUrl(url) || `title:${String(title || '').trim().toLowerCase()}`;
    if (key === 'title:') return null;
    if (byKey.has(key)) {
      const existing = byKey.get(key);
      if (!existing.date && date) existing.date = formatDate(date);
      if (!existing.sourceName && sourceName) existing.sourceName = sourceName;
      return existing.n;
    }
    const entry = {
      n: list.length + 1,
      title: String(title || url || 'Untitled').trim(),
      url: url ? String(url).trim() : null,
      sourceName: sourceName ? String(sourceName).trim() : null,
      date: formatDate(date),
    };
    list.push(entry);
    byKey.set(key, entry);
    return entry.n;
  };
  return { list, add, get: (n) => list[n - 1] };
}

/** Rewrite a search's local citations to global numbers; returns {text, cites}. */
function renumber(text, topSources, registry) {
  const cites = [];
  const rewritten = String(text).replace(CITE_RE, (_m, nums) => {
    const globals = [];
    for (const local of nums.match(/\d+/g) || []) {
      const src = topSources[Number(local) - 1];
      if (!src) continue; // citation points nowhere: drop it rather than mislead
      const n = registry.add({
        title: src.title, url: src.url || src.link, sourceName: src.sourceName || src.source_name || null,
        date: src.date || src.publishedAt || src.published_at || null,
      });
      if (n && !globals.includes(n)) globals.push(n);
    }
    globals.forEach((n) => { if (!cites.includes(n)) cites.push(n); });
    return globals.length ? `[${globals.join(', ')}]` : '';
  }).replace(/\s+([.,;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return { text: rewritten, cites };
}

/** Append the fact's date unless the line already shows it. */
function withDate(text, date, label = '') {
  if (!date) return text;
  if (String(date).split(', ').every((d) => text.includes(d))) return text;
  return `${text} (${label}${date})`;
}

/** Date of a fact: its cited sources' dates (known ones), else the search date. */
function factDate(cites, registry, searchDate) {
  const dates = [...new Set(cites.map((n) => registry.get(n)?.date).filter(Boolean))];
  if (dates.length) return { date: dates.join(', '), label: '' };
  return searchDate ? { date: searchDate, label: 'search run ' } : { date: null, label: '' };
}

function blocksFor(lines, search, registry, { dated = true } = {}) {
  const top = asArray(search.top_sources);
  const searchDate = formatDate(search.created_at);
  return linesToBlocks(lines).map((b) => {
    if (b.type === 'subheading') return { ...b, cites: [] };
    const { text, cites } = renumber(b.text, top, registry);
    if (!text) return null;
    if (!dated) return { type: b.type, text, cites };
    const { date, label } = factDate(cites, registry, searchDate);
    return { type: b.type, text: withDate(text, date, label), cites, date };
  }).filter(Boolean);
}

const byNewest = (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0);

/**
 * Build the structured memo.
 * @param {object} detail - getWorkspaceDetail() result
 * @param {{searchIds?: string[], now?: Date}} options
 */
export function buildMemo(detail, { searchIds, now } = {}) {
  const workspace = detail?.workspace || {};
  const company = String(workspace.company || workspace.name || 'Company').trim();
  const generatedAt = (now || new Date()).toISOString();
  const registry = createRegistry();

  let searches = [...(detail?.searches || [])].sort(byNewest);
  if (Array.isArray(searchIds) && searchIds.length) {
    const wanted = new Set(searchIds.map(String));
    searches = searches.filter((s) => wanted.has(String(s.id)));
  }
  const parsed = searches
    .map((s) => ({ search: s, sections: parseSummarySections(s.summary) }))
    .filter((p) => Object.keys(p.sections).length);
  const many = parsed.length > 1;
  const groupLabel = (s) => ({ type: 'subheading', text: `From search “${s.query}” (${formatDate(s.created_at) || 'undated'})`, cites: [] });

  // Executive summary: newest first, at most 3.
  const executive = [];
  for (const { search, sections } of parsed) {
    if (executive.filter((b) => b.type === 'subheading').length >= MAX_EXEC_SUMMARIES) break;
    if (!sections.summary) continue;
    const blocks = blocksFor(sections.summary, search, registry);
    if (!blocks.length) continue;
    executive.push(groupLabel(search), ...blocks);
  }
  const execBlocks = executive.filter((b) => b.type === 'subheading').length > 1 ? executive : executive.filter((b) => b.type !== 'subheading');

  // Deduped collections across searches.
  const collect = (key, { dated = true, grouped = false } = {}) => {
    const seen = new Set();
    const out = [];
    for (const { search, sections } of parsed) {
      if (!sections[key]) continue;
      const fresh = blocksFor(sections[key], search, registry, { dated }).filter((b) => {
        if (b.type === 'subheading') return true;
        const k = dedupeKey(b.text);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      // drop subheadings that end up with no content beneath them
      const cleaned = fresh.filter((b, i) => b.type !== 'subheading' || (fresh[i + 1] && fresh[i + 1].type !== 'subheading'));
      if (!cleaned.length) continue;
      if (grouped && many) out.push(groupLabel(search));
      out.push(...cleaned);
    }
    return out;
  };
  const keyPoints = collect('keyPoints');
  const detailed = collect('detailed', { grouped: true });
  const perspectives = collect('perspectives');
  const openQuestions = collect('followUp', { dated: false });

  // Analyst notes: verbatim, dated (oldest first reads as a log).
  const notes = [...(detail?.notes || [])].sort((a, b) => -byNewest(a, b))
    .filter((n) => String(n.body || '').trim())
    .map((n) => ({ type: 'bullet', text: `${formatDate(n.created_at) || 'Undated'}: ${String(n.body).trim()}`, cites: [], date: formatDate(n.created_at) }));

  // Saved sources: pinned, with excerpts.
  const saved = [...(detail?.sources || [])].map((s) => {
    const n = registry.add({ title: s.title, url: s.url, sourceName: s.source_name, date: s.published_at });
    const date = formatDate(s.published_at);
    const meta = [s.source_name, date || (s.created_at ? `saved ${formatDate(s.created_at)}` : null)].filter(Boolean).join(', ');
    const excerpt = String(s.excerpt || '').trim().replace(/\s+/g, ' ');
    const text = `**${String(s.title || s.url).trim()}**${meta ? ` (${meta})` : ''}${excerpt ? `: “${excerpt}”` : ''}${n ? ` [${n}]` : ''}`;
    return { type: 'bullet', text, cites: n ? [n] : [], date: date || formatDate(s.created_at) };
  });

  // Data-room documents: names and dates only.
  const documents = [...(detail?.documents || [])].sort(byNewest)
    .map((d) => ({ type: 'bullet', text: `${String(d.name || 'Document').trim()} (added ${formatDate(d.created_at) || 'undated'})`, cites: [], date: formatDate(d.created_at) }));

  const sections = [
    { heading: 'Executive summary', blocks: execBlocks },
    { heading: 'Key points', blocks: keyPoints },
    { heading: 'Detailed analysis', blocks: detailed },
    { heading: 'Different perspectives', blocks: perspectives },
    { heading: 'Analyst notes', blocks: notes },
    { heading: 'Saved sources', blocks: saved },
    { heading: 'Data-room documents', blocks: documents },
    { heading: 'Open questions', blocks: openQuestions },
  ].filter((s) => s.blocks.some((b) => b.type !== 'subheading'));

  return {
    title: `${company}: Investment memo`,
    company,
    workspaceName: String(workspace.name || company),
    generatedAt,
    preparedWith: 'Prepared with Research Hub',
    searchCount: parsed.length,
    sections,
    sources: registry.list.map((s) => ({ ...s })),
  };
}

// ---------- Markdown ----------

export function memoToMarkdown(memo) {
  const out = [];
  out.push(`# ${memo.title}`, '');
  out.push(`**Company:** ${memo.company}  `);
  out.push(`**Workspace:** ${memo.workspaceName}  `);
  out.push(`**Generated:** ${formatDate(memo.generatedAt)}  `);
  out.push(`*${memo.preparedWith || 'Prepared with Research Hub'}*`, '');
  for (const section of memo.sections) {
    out.push(`## ${section.heading}`, '');
    let prev = null;
    for (const b of section.blocks) {
      if (b.type === 'subheading') {
        if (prev === 'bullet') out.push('');
        out.push(`### ${b.text}`, '');
      } else if (b.type === 'bullet') {
        out.push(`- ${b.text.replace(/\r?\n/g, '\n  ')}`);
      } else {
        if (prev === 'bullet') out.push('');
        out.push(b.text, '');
      }
      prev = b.type;
    }
    if (prev === 'bullet') out.push('');
  }
  if (memo.sources.length) {
    out.push('## Sources', '');
    for (const s of memo.sources) {
      const meta = [s.sourceName, s.date || 'undated'].filter(Boolean).join(', ');
      out.push(`${s.n}. ${s.url ? `[${s.title.replace(/([[\]])/g, '\\$1')}](${s.url})` : s.title} (${meta})${s.url ? `. ${s.url}` : ''}`);
    }
    out.push('');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// ---------- Word (.docx) ----------

/** Inline **bold** into TextRuns. */
function runs(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((p) => (p.startsWith('**') && p.endsWith('**') && p.length > 4
    ? new TextRun({ text: p.slice(2, -2), bold: true })
    : new TextRun({ text: p })));
}

function textLines(text, opts = {}) {
  // Notes may be multi-line: keep them as line breaks inside one paragraph.
  const lines = String(text).split(/\r?\n/);
  const children = [];
  lines.forEach((line, i) => {
    if (i > 0) children.push(new TextRun({ text: '', break: 1 }));
    children.push(...runs(line));
  });
  return new Paragraph({ children, ...opts });
}

export async function memoToDocx(memo) {
  const children = [];
  children.push(new Paragraph({ text: memo.title, heading: HeadingLevel.TITLE }));
  children.push(new Paragraph({ children: [new TextRun({ text: 'Company: ', bold: true }), new TextRun(memo.company)] }));
  children.push(new Paragraph({ children: [new TextRun({ text: 'Workspace: ', bold: true }), new TextRun(memo.workspaceName)] }));
  children.push(new Paragraph({ children: [new TextRun({ text: 'Generated: ', bold: true }), new TextRun(formatDate(memo.generatedAt))] }));
  children.push(new Paragraph({ children: [new TextRun({ text: memo.preparedWith || 'Prepared with Research Hub', italics: true })], spacing: { after: 300 } }));

  for (const section of memo.sections) {
    children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 120 } }));
    for (const b of section.blocks) {
      if (b.type === 'subheading') children.push(new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_3, spacing: { before: 160 } }));
      else if (b.type === 'bullet') children.push(textLines(b.text, { bullet: { level: 0 } }));
      else children.push(textLines(b.text, { spacing: { after: 120 } }));
    }
  }

  if (memo.sources.length) {
    children.push(new Paragraph({ text: 'Sources', heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 120 } }));
    for (const s of memo.sources) {
      const meta = [s.sourceName, s.date || 'undated'].filter(Boolean).join(', ');
      const parts = [new TextRun({ text: `[${s.n}] ` , bold: true })];
      if (s.url) {
        parts.push(new ExternalHyperlink({ link: s.url, children: [new TextRun({ text: s.title, style: 'Hyperlink' })] }));
      } else {
        parts.push(new TextRun(s.title));
      }
      parts.push(new TextRun(` (${meta})`));
      if (s.url) parts.push(new TextRun({ text: s.url, break: 1, size: 18, color: '555555' }));
      children.push(new Paragraph({ children: parts, spacing: { after: 100 } }));
    }
  }

  const doc = new Document({
    creator: 'Research Hub',
    title: memo.title,
    description: `Investment memo for ${memo.company}`,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

/** "<company>-memo-<yyyy-mm-dd>.<ext>" with a filesystem/header-safe company part. */
export function memoFilename(memo, ext) {
  const base = String(memo.company || 'workspace')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace';
  return `${base}-memo-${formatDate(memo.generatedAt)}.${ext}`;
}
