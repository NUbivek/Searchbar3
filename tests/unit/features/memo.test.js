import { buildMemo, memoToMarkdown, memoToDocx, memoFilename, parseSummarySections } from '../../../src/server/memo';

const shared = { title: 'Series D announced', url: 'https://example.com/series-d', sourceName: 'Example News', date: '2026-09-08', snippet: 'x' };
const onlyA = { title: 'Founders interview', url: 'https://blog.example.org/interview', sourceName: 'Example Blog', date: '2024-03-22', snippet: 'y' };
const onlyB = { title: 'NVIDIA partnership', url: 'https://example.com/nvidia', sourceName: 'Example News', date: null, snippet: 'z' };

const searchOld = {
  id: 's-old', query: 'Acme funding', created_at: '2026-10-01T10:00:00Z',
  top_sources: [onlyA, shared],
  summary: [
    '## SUMMARY', 'Acme raised a Series D [Source 2]. It was founded quickly [Source 1].', '',
    '## KEY POINTS', '• Acme raised €3B in a Series D [Source 2]', '• Acme shipped models in year one [Source 1]', '',
    '## DETAILED ANALYSIS', 'The sources contain no further detail beyond the key points above.', '',
    '## FOLLOW-UP QUESTIONS', '• Who led the round?', '• Who are the competitors?', '',
    '---', '*Results synthesized from 2 sources*',
  ].join('\n'),
};

const searchNew = {
  id: 's-new', query: 'Acme partnerships', created_at: '2026-11-01T10:00:00Z',
  // same Series D article, but at local position 1, and with a www./trailing-slash URL variant
  top_sources: [{ ...shared, url: 'https://www.example.com/series-d/' }, onlyB],
  summary: [
    '## SUMMARY', 'After its Series D [Source 1], Acme partnered with NVIDIA [Source 2].', '',
    '## KEY POINTS', '• Acme raised €3B in a Series D [Source 1]', '• Acme partners with NVIDIA [Source 2]', '',
    '## FOLLOW-UP QUESTIONS', '• Who led the round?',
  ].join('\n'),
};

const detail = (overrides = {}) => ({
  workspace: { id: 'w1', name: 'Acme deal', company: 'Acme AI', created_at: '2026-09-01', updated_at: '2026-11-01' },
  searches: [searchOld, searchNew],
  notes: [{ id: 'n1', body: 'Met the CEO.\nAsk about burn.', created_at: '2026-10-15T09:00:00Z' }],
  sources: [],
  documents: [],
  ...overrides,
});

const section = (memo, heading) => memo.sections.find((s) => s.heading === heading);
const NOW = new Date('2026-11-06T12:00:00Z');

describe('memo builder', () => {
  test('parses summary sections and ignores the footer', () => {
    const s = parseSummarySections(searchOld.summary);
    expect(Object.keys(s)).toEqual(['summary', 'keyPoints', 'detailed', 'followUp']);
    expect(s.followUp.join('\n')).not.toMatch(/Results synthesized/);
  });

  test('renumbers citations globally across two searches sharing a source', () => {
    const memo = buildMemo(detail(), { now: NOW });
    // numbered in order of first appearance in the memo; newest search first: its Source 1 (shared) -> [1], Source 2 (onlyB) -> [2]; old search's Source 1 (onlyA) -> [3]
    expect(memo.sources.map((s) => s.title)).toEqual(['Series D announced', 'NVIDIA partnership', 'Founders interview']);
    expect(memo.sources.map((s) => s.n)).toEqual([1, 2, 3]);
    const exec = section(memo, 'Executive summary').blocks.filter((b) => b.type === 'paragraph');
    expect(exec[0].text).toMatch(/Series D \[1\], Acme partnered with NVIDIA \[2\]/);
    expect(exec[1].text).toMatch(/Series D \[1\]\. It was founded quickly \[3\]/);
    expect(exec.every((b) => !/Source \d/.test(b.text))).toBe(true);
  });

  test('dedupes the shared source by URL and dedupes key points / questions', () => {
    const memo = buildMemo(detail(), { now: NOW });
    expect(memo.sources.filter((s) => /series-d/.test(s.url))).toHaveLength(1);
    const kp = section(memo, 'Key points').blocks;
    expect(kp.filter((b) => /€3B/.test(b.text))).toHaveLength(1);
    expect(kp).toHaveLength(3);
    const qs = section(memo, 'Open questions').blocks.map((b) => b.text);
    expect(qs).toEqual(['Who led the round?', 'Who are the competitors?']);
  });

  test('each fact carries a date: source date, else search date', () => {
    const memo = buildMemo(detail(), { now: NOW });
    const kp = section(memo, 'Key points').blocks;
    expect(kp.find((b) => /€3B/.test(b.text)).text).toMatch(/\(2026-09-08\)$/);
    // NVIDIA source has no date -> falls back to the date the search ran
    expect(kp.find((b) => /NVIDIA/.test(b.text)).text).toMatch(/\(search run 2026-11-01\)$/);
  });

  test('omits empty sections and boilerplate', () => {
    const memo = buildMemo(detail(), { now: NOW });
    const headings = memo.sections.map((s) => s.heading);
    expect(headings).toEqual(['Executive summary', 'Key points', 'Analyst notes', 'Open questions']);
    expect(headings).not.toContain('Detailed analysis');
    expect(headings).not.toContain('Data-room documents');

    const empty = buildMemo(detail({ searches: [], notes: [] }), { now: NOW });
    expect(empty.sections).toEqual([]);
    expect(empty.sources).toEqual([]);
  });

  test('searchIds limits the searches used', () => {
    const memo = buildMemo(detail(), { searchIds: ['s-old'], now: NOW });
    expect(memo.sources.map((s) => s.title)).toEqual(['Series D announced', 'Founders interview']);
  });

  test('saved sources and documents are included; saved source URL dedupes against citations', () => {
    const memo = buildMemo(detail({
      sources: [{ id: 'p1', title: 'Series D announced', url: 'https://example.com/series-d', source_name: 'Example News', published_at: '2026-09-08', excerpt: 'raised €3 billion', created_at: '2026-10-02' }],
      documents: [{ id: 'd1', name: 'Deck.pdf', size: 100, created_at: '2026-10-05T00:00:00Z' }],
    }), { now: NOW });
    expect(memo.sources).toHaveLength(3);
    expect(section(memo, 'Saved sources').blocks[0].text).toMatch(/raised €3 billion.*\[1\]$/);
    expect(section(memo, 'Data-room documents').blocks[0].text).toBe('Deck.pdf (added 2026-10-05)');
  });
});

describe('renderers', () => {
  test('markdown has title page, sections and numbered sources with dates', () => {
    const md = memoToMarkdown(buildMemo(detail(), { now: NOW }));
    expect(md).toMatch(/^# Acme AI: Investment memo/);
    expect(md).toMatch(/Prepared with Research Hub/);
    expect(md).toMatch(/\*\*Generated:\*\* 2026-11-06/);
    expect(md).toMatch(/## Analyst notes\n\n- 2026-10-15: Met the CEO\.\n {2}Ask about burn\./);
    expect(md).toMatch(/## Sources\n\n1\. \[Series D announced\]\(https:\/\/www\.example\.com\/series-d\/\) \(Example News, 2026-09-08\)/);
    expect(md).toMatch(/2\. \[NVIDIA partnership\].*\(Example News, undated\)/);
    expect(md).toMatch(/3\. \[Founders interview\].*\(Example Blog, 2024-03-22\)/);
  });

  test('docx returns a non-empty zip buffer', async () => {
    const buf = await memoToDocx(buildMemo(detail(), { now: NOW }));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.slice(0, 2).toString()).toBe('PK');
  });

  test('filename is sanitized', () => {
    expect(memoFilename({ company: 'Ünïcode "Co" / Ltd.', generatedAt: NOW.toISOString() }, 'md')).toBe('Unicode-Co-Ltd-memo-2026-11-06.md');
  });
});
