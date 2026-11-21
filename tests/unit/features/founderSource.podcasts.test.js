/**
 * @jest-environment node
 *
 * Podcast episodes (podcasts.js): Apple's podcast directory search. Off unless
 * the deployment turns it on; an episode counts only when its own title or
 * description names the person in full (and the company too, for a common name
 * or a one-word company); never 'confirmed'; no audio, preview, artwork or feed
 * links kept; failures throw. No network: fixtures follow the shape the service
 * answered with on 2026-11-20, shortened, with invented people.
 */
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), persistenceMode: jest.fn(() => 'none') }));

const { setTransport } = require('../../../src/server/founder/http');
const { createSubject } = require('../../../src/server/founder/identity');
const {
  podcastEpisodesConnector: P, parseEpisodes, isCommonName, searchUrl, __resetPodcastsForTests, RESULT_LIMIT,
} = require('../../../src/server/founder/sources/podcasts');

const ctxFor = (subject) => ({ subject, deadline: Date.now() + 20000, known: () => ({}) });
const task = (params = { withCompany: true }) => ({ kind: 'subject', value: 'x', template: params.withCompany ? 'podcasts:name-company' : 'podcasts:name', params, depth: 0, relation: null });

/** One result in the service's own shape, with every field it sends (the ones that must never be kept included). */
const episode = (o) => ({
  wrapperType: 'podcastEpisode', kind: 'podcast-episode',
  previewUrl: 'https://rss.example-host.com/episodes/abc.mp3?rss_browser=x',
  episodeUrl: 'https://rss.example-host.com/episodes/abc.mp3',
  artworkUrl600: 'https://is1-ssl.mzstatic.com/image/thumb/a/600x600bb.jpg',
  artworkUrl160: 'https://is1-ssl.mzstatic.com/image/thumb/a/160x160bb.jpg',
  artworkUrl60: 'https://is1-ssl.mzstatic.com/image/thumb/a/60x60bb.jpg',
  feedUrl: 'https://rss.example-host.com/show',
  collectionViewUrl: 'https://itunes.apple.com/us/podcast/show/id1?mt=2&uo=4',
  artistIds: [], genres: [{ name: 'Business', id: '1321' }], episodeGuid: 'g', closedCaptioning: 'none', country: 'USA',
  episodeFileExtension: 'mp3', episodeContentType: 'audio', contentAdvisoryRating: 'Clean', trackTimeMillis: 3600000,
  collectionId: 1, trackId: Math.floor(Math.random() * 1e9), shortDescription: '',
  releaseDate: '2024-03-05T09:00:00Z',
  trackViewUrl: `https://podcasts.apple.com/us/podcast/ep/id1?i=${Math.floor(Math.random() * 1e9)}&uo=4`,
  ...o,
});
const answer = (results) => ({ resultCount: results.length, results });

const QUILL = [
  episode({ trackName: 'Marguerite Oyelaran on building Quillfeather Robotics', collectionName: 'Founders Hour', description: 'This week we sit down with Marguerite Oyelaran, founder and CEO of Quillfeather Robotics, about warehouse arms. Write to us at hello@foundershour.example. See Privacy Policy at https://example.com/privacy.', trackViewUrl: 'https://podcasts.apple.com/us/podcast/margo/id11?i=1000111&uo=4', releaseDate: '2023-06-01T07:00:00Z' }),
  episode({ trackName: 'The robot startup that ran out of road', collectionName: 'Bad Bets Daily', description: 'Investors say Quillfeather Robotics overstated orders. Marguerite Oyelaran was charged with securities fraud last spring. She was diagnosed with cancer in 2019.', trackViewUrl: 'https://podcasts.apple.com/us/podcast/road/id12?i=1000112&uo=4', releaseDate: '2025-02-10T07:00:00Z' }),
  episode({ trackName: 'Gardening with Marguerite Oyelaran', collectionName: 'Backyard Hour', description: 'Marguerite Oyelaran shares her tomato tips.', trackViewUrl: 'https://podcasts.apple.com/us/podcast/garden/id13?i=1000113&uo=4' }),
  episode({ trackName: 'don’t embarrass me', collectionName: 'The Morning Show with Marguerite Oyelaran', description: 'A chat about mornings and coffee.', trackViewUrl: 'https://podcasts.apple.com/us/podcast/mornings/id14?i=1000114&uo=4' }),
  episode({ trackName: 'Panel recap', collectionName: 'Tech Weekly', description: 'Our guest Marguerite Oyelaran Brooks talked about design systems.', trackViewUrl: 'https://podcasts.apple.com/us/podcast/panel/id15?i=1000115&uo=4' }),
  { wrapperType: 'track', kind: 'song', trackName: 'Marguerite Oyelaran (song)', trackViewUrl: 'https://music.apple.com/x' },
];

/** Fake network: answers each search with `reply(url)`; { status, body } sets the status. */
function network(reply) {
  const calls = [];
  setTransport(async (url, init) => {
    calls.push({ url, ua: init?.headers?.['User-Agent'] });
    const r = typeof reply === 'function' ? reply(url) : reply;
    const custom = r && typeof r.status === 'number';
    const body = custom ? r.body : r;
    return { status: custom ? r.status : 200, headers: new Map(), url, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  });
  return calls;
}

const OLD_ENV = { ...process.env };
beforeEach(() => __resetPodcastsForTests());
afterEach(() => { setTransport(); process.env = { ...OLD_ENV }; });

describe('switch', () => {
  test('off unless FOUNDER_SOURCES_ON names it, and FOUNDER_SOURCES_OFF still wins', () => {
    delete process.env.FOUNDER_SOURCES_ON;
    delete process.env.FOUNDER_SOURCES_OFF;
    expect(P.enabled()).toBe(false);
    expect(P.unavailableReason).toMatch(/not enabled on this deployment/);
    expect(P.unavailableReason).not.toMatch(/\b(api|endpoint|key|token|free|paid|tier|env)\b/i);
    process.env.FOUNDER_SOURCES_ON = 'something-else, podcast-episodes';
    expect(P.enabled()).toBe(true);
    process.env.FOUNDER_SOURCES_OFF = 'podcast-episodes';
    expect(P.enabled()).toBe(false);
  });

  test('contract: subject only, one lookup at a time, plans without names', () => {
    expect(P.kinds).toEqual(['subject']);
    expect(P.maxParallel).toBe(1);
    const s = createSubject({ name: 'Marguerite Oyelaran', company: 'Quillfeather Robotics' });
    const plans = P.plan({ kind: 'subject', value: s.name }, s);
    expect(plans.map((p) => p.template)).toEqual(['podcasts:name-company', 'podcasts:name']);
    for (const p of plans) expect(p.template).not.toMatch(/oyelaran|quillfeather/i);
    expect(P.plan({ kind: 'subject', value: 'X Y' }, createSubject({ name: 'Marguerite Oyelaran' })).map((p) => p.template)).toEqual(['podcasts:name']);
    expect(P.plan({ kind: 'company', value: 'Quillfeather Robotics' }, s)).toEqual([]);
  });
});

describe('reading the answer', () => {
  test('keeps title, show, date, description and the page link only', () => {
    const eps = parseEpisodes(answer(QUILL));
    expect(eps).toHaveLength(5); // the song is not an episode
    expect(eps[0]).toEqual({ title: 'Marguerite Oyelaran on building Quillfeather Robotics', show: 'Founders Hour', date: '2023-06-01', description: expect.stringContaining('sit down with'), url: 'https://podcasts.apple.com/us/podcast/margo/id11?i=1000111' });
    expect(JSON.stringify(eps)).not.toMatch(/mzstatic|\.mp3|rss\.example-host|artwork|preview/);
  });

  test('a changed or broken format throws instead of reading as "no episodes"', () => {
    expect(() => parseEpisodes({ results: [] })).toThrow(/unexpected format/);
    expect(() => parseEpisodes({ resultCount: 3, results: [] })).toThrow(/reported results/);
    expect(() => parseEpisodes(answer([{ wrapperType: 'podcastEpisode', name: 'x', link: 'y' }]))).toThrow(/format may have changed/);
    expect(parseEpisodes(answer([]))).toEqual([]);
  });

  test('the search asks for episodes, 25 at most', () => {
    const u = new URL(searchUrl('Marguerite Oyelaran Quillfeather Robotics'));
    expect(u.hostname).toBe('itunes.apple.com');
    expect(u.searchParams.get('term')).toBe('Marguerite Oyelaran Quillfeather Robotics');
    expect(u.searchParams.get('media')).toBe('podcast');
    expect(u.searchParams.get('entity')).toBe('podcastEpisode');
    expect(u.searchParams.get('limit')).toBe(String(RESULT_LIMIT));
  });

  test('common names', () => {
    expect(isCommonName('John Smith')).toBe(true);
    expect(isCommonName('Wei Li')).toBe(true);
    expect(isCommonName('Marguerite Oyelaran')).toBe(false);
    expect(isCommonName('Cher')).toBe(true);
  });
});

describe('lookups', () => {
  test('name with company is likely, name alone stays possible, show names and longer names do not count', async () => {
    const calls = network(answer(QUILL));
    const subject = createSubject({ name: 'Marguerite Oyelaran', company: 'Quillfeather Robotics' });
    const out = await P.run(task(), ctxFor(subject));
    expect(calls).toHaveLength(1);
    expect(calls[0].ua).not.toMatch(/Mozilla/);
    expect(new URL(calls[0].url).searchParams.get('term')).toBe('Marguerite Oyelaran Quillfeather Robotics');
    const titles = out.findings.map((f) => f.title);
    expect(titles).toHaveLength(3);
    // never confirmed
    for (const f of out.findings) { expect(f.match).not.toBe('confirmed'); expect(f.matchFixed).toBe(true); }
    const interview = out.findings.find((f) => /building Quillfeather/.test(f.title));
    expect(interview.match).toBe('likely');
    expect(interview.title).toMatch(/^Podcast interview: .*\(Founders Hour, 2023\)$/);
    expect(interview.data).toEqual({ show: 'Founders Hour', kind: 'interview', namesCompany: true });
    expect(interview.url).toBe('https://podcasts.apple.com/us/podcast/margo/id11?i=1000111');
    expect(interview.date).toBe('2023-06-01');
    expect(interview.quote).not.toMatch(/hello@|privacy/i);
    const fraud = out.findings.find((f) => /ran out of road/.test(f.title));
    expect(fraud.match).toBe('likely');
    expect(['high', 'medium']).toContain(fraud.severity);
    expect(fraud.quote).not.toMatch(/cancer|diagnosed/);
    const garden = out.findings.find((f) => /Gardening/.test(f.title));
    expect(garden.match).toBe('possible');
    expect(garden.title).toMatch(/name match only, verify identity$/);
    // the namesake's own show and "Marguerite Oyelaran Brooks" are not kept
    expect(titles.join(' ')).not.toMatch(/embarrass|Panel recap/);
    expect(out.notes.join(' ')).toMatch(/3 of 5 episodes name Marguerite Oyelaran/);
    expect(JSON.stringify(out)).not.toMatch(/mzstatic|\.mp3|rss\.example-host/);
    // likely records come first
    expect(out.findings[out.findings.length - 1].match).toBe('possible');
  });

  test('a one-word company: episodes that do not name it are left out, and the note says why', async () => {
    network(answer([
      episode({ trackName: 'Dorian Velasquez-Hart, founder of Vantrix', collectionName: 'Startup Stories', description: 'How Vantrix, Inc. raised its first round.' }),
      episode({ trackName: 'Dorian Velasquez-Hart talks hydrogen', collectionName: 'Energy Now', description: 'A wide-ranging chat.' }),
    ]));
    const subject = createSubject({ name: 'Dorian Velasquez-Hart', company: 'Vantrix' });
    const out = await P.run(task({ withCompany: false }), ctxFor(subject));
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].match).toBe('likely');
    expect(out.notes.join(' ')).toMatch(/1 more episode names Dorian Velasquez-Hart without naming the company and was left out, because Vantrix is a one-word name/);
  });

  test('a common name needs the company too', async () => {
    network(answer([
      episode({ trackName: 'John Smith on Ardent Turbines', collectionName: 'Industry Talk', description: 'John Smith of Ardent Turbines joins us.' }),
      episode({ trackName: 'John Smith, poet', collectionName: 'Verse', description: 'John Smith reads new work.' }),
    ]));
    const subject = createSubject({ name: 'John Smith', company: 'Ardent Turbines' });
    const out = await P.run(task(), ctxFor(subject));
    expect(out.findings.map((f) => f.match)).toEqual(['likely']);
    expect(out.notes.join(' ')).toMatch(/John Smith is a common name/);
  });

  test('no company known: a rare name is kept as possible, a common name finds nothing', async () => {
    network(answer([episode({ trackName: 'Marguerite Oyelaran on robots', collectionName: 'Founders Hour', description: 'A talk.' })]));
    const out = await P.run(task({ withCompany: false }), ctxFor(createSubject({ name: 'Marguerite Oyelaran' })));
    expect(out.findings.map((f) => f.match)).toEqual(['possible']);
    expect(out.findings[0].title).toMatch(/verify identity/);
    network(answer([episode({ trackName: 'John Smith on robots', collectionName: 'Founders Hour', description: 'A talk.' })]));
    const common = await P.run(task({ withCompany: false }), ctxFor(createSubject({ name: 'John Smith' })));
    expect(common.findings).toHaveLength(0);
    expect(common.notes.join(' ')).toMatch(/John Smith is a common name/);
  });

  test('nothing found is said in plain words, and is not an error', async () => {
    network(answer([]));
    const out = await P.run(task(), ctxFor(createSubject({ name: 'Marguerite Oyelaran', company: 'Quillfeather Robotics' })));
    expect(out.findings).toEqual([]);
    expect(out.notes[0]).toMatch(/searched Apple's podcast directory for "Marguerite Oyelaran Quillfeather Robotics" and it returned no episodes/);
    network(answer([episode({ trackName: 'Something else', collectionName: 'Show', description: 'Unrelated.' })]));
    const none = await P.run(task(), ctxFor(createSubject({ name: 'Marguerite Oyelaran', company: 'Quillfeather Robotics' })));
    expect(none.findings).toEqual([]);
    expect(none.notes[0]).toMatch(/none of the 1 episodes returned names Marguerite Oyelaran/);
  });

  test('a full page of answers says more may exist', async () => {
    network(answer(Array.from({ length: RESULT_LIMIT }, (_, i) => episode({ trackName: `Episode ${i}`, collectionName: 'Show', description: 'Unrelated.' }))));
    const out = await P.run(task(), ctxFor(createSubject({ name: 'Marguerite Oyelaran', company: 'Quillfeather Robotics' })));
    expect(out.notes.join(' ')).toMatch(/Only the 25 most relevant episodes/);
  });

  test('a one-word name is not searched, and the lookup is marked partial', async () => {
    const calls = network(answer([]));
    const out = await P.run({ kind: 'subject', value: 'Cher', params: { withCompany: false } }, ctxFor(createSubject({ name: 'Cher' })));
    expect(calls).toHaveLength(0);
    expect(out.partial).toEqual(['name too short to search']);
    expect(out.notes[0]).toMatch(/not a full name/);
  });

  test('failures throw: an error status, a body that is not JSON, a changed format', async () => {
    const subject = createSubject({ name: 'Marguerite Oyelaran', company: 'Quillfeather Robotics' });
    network({ status: 500, body: 'oops' });
    await expect(P.run(task(), ctxFor(subject))).rejects.toThrow();
    network('<html>busy</html>');
    await expect(P.run(task(), ctxFor(subject))).rejects.toThrow(/not JSON/);
    network({ results: 'nope' });
    await expect(P.run(task(), ctxFor(subject))).rejects.toThrow(/unexpected format/);
  });
});
