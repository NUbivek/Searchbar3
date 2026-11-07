jest.mock('../../../src/server/together', () => ({
  completeWithTogether: jest.fn(),
  togetherConfigured: jest.fn(),
}));
jest.mock('../../../src/utils/sources/curatedIndex', () => ({
  searchCuratedSources: jest.fn(async () => []),
}));

const { completeWithTogether, togetherConfigured } = require('../../../src/server/together');
const { searchCuratedSources } = require('../../../src/utils/sources/curatedIndex');
const {
  chunkDocument, bm25Rank, answerQuestion, verifyAnswer, EXTRACTIVE_NOTE, FALLBACK_NOTE,
} = require('../../../src/server/dataroom');

const MEMO = {
  id: 'doc-1',
  name: 'Board memo.txt',
  content: [
    'Acme Board Memo, Q3.',
    'Annual recurring revenue reached $4.2M, up from $2.9M a year ago.',
    'The company is raising a Series B of $25M led by Example Ventures.',
    'Gross margin is 71% after the hosting migration.',
    'Net burn is $600k per month.',
    'At the current burn the company has 26 months of runway.',
    'Headcount is 48 across engineering, sales and support.',
  ].join('\n'),
};

const LONG_DOC = {
  id: 'doc-2',
  name: 'Long.txt',
  content: Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} talks about topic ${i % 7} in some detail here.`).join(' '),
};

beforeEach(() => {
  jest.clearAllMocks();
  togetherConfigured.mockReturnValue(false);
});

describe('chunkDocument', () => {
  test('splits into ~800 char passages with overlap and metadata', () => {
    const passages = chunkDocument(LONG_DOC);
    expect(passages.length).toBeGreaterThan(2);
    passages.forEach((p, i) => {
      expect(p).toMatchObject({ docId: 'doc-2', docName: 'Long.txt', passageIndex: i });
      expect(p.text.length).toBeLessThanOrEqual(800 + 100);
    });
    // Consecutive passages share text (overlap).
    for (let i = 1; i < passages.length; i += 1) {
      const prevLastSentence = passages[i - 1].text.split(/(?<=\.)\s+/).pop();
      const firstSentence = passages[i].text.split(/(?<=\.)\s+/)[0];
      expect(passages[i].text).toContain(prevLastSentence);
      expect(passages[i - 1].text).toContain(firstSentence);
    }
    // Every sentence of the source appears in some passage.
    const all = passages.map((p) => p.text).join(' ');
    for (let i = 1; i <= 40; i += 1) expect(all).toContain(`Sentence number ${i} talks`);
  });

  test('hard-splits a single very long sentence with overlap', () => {
    const passages = chunkDocument({ id: 'x', name: 'x', content: 'word '.repeat(600) });
    expect(passages.length).toBeGreaterThan(1);
    passages.forEach((p) => expect(p.text.length).toBeLessThanOrEqual(900));
  });
});

describe('bm25Rank', () => {
  test('ranks the passage that answers the question first', () => {
    const passages = [
      { text: 'The team has offices in Berlin and London.' },
      { text: 'Runway is 26 months at the current burn rate.' },
      { text: 'Revenue grew strongly; the burn decreased.' },
    ];
    const ranked = bm25Rank('What is the runway?', passages);
    expect(ranked[0].text).toContain('Runway is 26 months');
    expect(ranked.every((r) => r.score > 0)).toBe(true);
  });

  test('returns nothing when no term matches', () => {
    expect(bm25Rank('What is the CAC?', [{ text: 'Runway is 26 months.' }])).toEqual([]);
  });
});

describe('answerQuestion (extractive, no model)', () => {
  test('quotes sentences verbatim with valid [Dn] labels', async () => {
    const result = await answerQuestion({ question: 'What is the runway?', documents: [MEMO] });
    expect(result.mode).toBe('extractive');
    expect(result.note).toBe(EXTRACTIVE_NOTE);
    expect(result.notFound).toBe(false);
    expect(completeWithTogether).not.toHaveBeenCalled();
    const lines = result.answer.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(5);
    const labels = new Set(result.passages.map((p) => p.label));
    for (const line of lines) {
      const m = line.match(/^"(.+)" \[(D\d+)\]$/);
      expect(m).not.toBeNull();
      expect(labels.has(m[2])).toBe(true);
      expect(MEMO.content).toContain(m[1]); // verbatim
    }
    expect(result.answer).toContain('26 months of runway');
    expect(result.citations[0]).toMatchObject({ label: 'D1', docName: 'Board memo.txt', passageIndex: 0 });
  });

  test('notFound when nothing matches, without calling the model', async () => {
    togetherConfigured.mockReturnValue(true);
    const result = await answerQuestion({ question: 'What is the CAC?', documents: [MEMO] });
    expect(result.notFound).toBe(true);
    expect(result.citations).toEqual([]);
    expect(completeWithTogether).not.toHaveBeenCalled();
  });
});

describe('answerQuestion (AI mode)', () => {
  beforeEach(() => togetherConfigured.mockReturnValue(true));

  test('keeps cited sentences and drops sentences with invented labels', async () => {
    completeWithTogether.mockResolvedValue({
      model: 'm',
      text: 'The Series B of $25M is led by Example Ventures [D1]. Sequoia also joined the round [D7]. Everyone loves it.',
    });
    const result = await answerQuestion({ question: 'Who leads the Series B?', documents: [MEMO] });
    expect(result.mode).toBe('ai');
    expect(result.answer).toBe('The Series B of $25M is led by Example Ventures [D1].');
    expect(result.answer).not.toContain('Sequoia');
    expect(result.citations.map((c) => c.label)).toEqual(['D1']);
    expect(result.passages.length).toBeGreaterThan(0);
  });

  test('drops sentences whose numbers are not in the cited passage', async () => {
    completeWithTogether.mockResolvedValue({ model: 'm', text: 'Runway is 26 months [D1]. Runway is 30 months [D1].' });
    const result = await answerQuestion({ question: 'What is the runway?', documents: [MEMO] });
    expect(result.answer).toBe('Runway is 26 months [D1].');
  });

  test('falls back to extractive when no citation is valid', async () => {
    completeWithTogether.mockResolvedValue({ model: 'm', text: 'Runway is long [D9]. It is fine.' });
    const result = await answerQuestion({ question: 'What is the runway?', documents: [MEMO] });
    expect(result.mode).toBe('extractive');
    expect(result.note).toBe(FALLBACK_NOTE);
    expect(result.answer).toContain('26 months of runway');
  });

  test('falls back to extractive when the model call fails', async () => {
    completeWithTogether.mockResolvedValue(null);
    const result = await answerQuestion({ question: 'What is the runway?', documents: [MEMO] });
    expect(result.mode).toBe('extractive');
  });

  test('includes curated sources as [Sn] when requested', async () => {
    searchCuratedSources.mockResolvedValueOnce([
      { title: 'Acme raises Series B', url: 'https://example.com/a', sourceName: 'Example News', content: 'Acme raised a $25M Series B led by Example Ventures.' },
    ]);
    completeWithTogether.mockResolvedValue({ model: 'm', text: 'Example Ventures leads the $25M Series B [D1][S1].' });
    const result = await answerQuestion({ question: 'Who leads the Series B?', documents: [MEMO], includeSources: true });
    expect(completeWithTogether.mock.calls[0][0]).toContain('[S1] (curated source: Example News');
    expect(result.citations.map((c) => c.label)).toEqual(['D1', 'S1']);
    expect(result.citations[1]).toMatchObject({ sourceName: 'Example News', url: 'https://example.com/a' });
  });
});

describe('verifyAnswer', () => {
  test('handles grouped labels and the not-found phrase', () => {
    const ctx = new Map([['D1', { text: 'ARR $4.2M' }], ['D2', { text: 'margin 71%' }]]);
    const v = verifyAnswer('ARR is $4.2M and margin 71% [D1, D2]. Not found in the documents.', ctx);
    expect(v.sentences).toEqual(['ARR is $4.2M and margin 71% [D1, D2].']);
    expect(v.saidNotFound).toBe(true);
  });
});
