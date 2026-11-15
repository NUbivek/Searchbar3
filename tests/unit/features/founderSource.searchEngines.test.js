/**
 * @jest-environment node
 *
 * The keyless search engines behind the open-web and news sources of the
 * deep background check: one parser test per engine (fixtures cut from real
 * responses fetched on 2026-11-14), how a query is put to each engine, the
 * fallback order, cooldowns, allowances, and the metered last resort.
 */
jest.mock('../../../src/server/search/retrieve', () => ({
  searchWeb: jest.fn(async () => []),
  webSearchConfigured: jest.fn(() => false),
}));

import { setTransport } from '../../../src/server/founder/http';
import { searchWeb, webSearchConfigured } from '../../../src/server/search/retrieve';
import {
  ENGINES, EngineBlocked, keylessSearch, engineHealth, engineOrder, __resetEnginesForTests,
  parseGoogleNews, parseBingNews, parseGdelt, parseDuckDuckGo, parseBrave, parseWikipedia,
  siteFilters, withoutShortWords, MAX_ENGINES_PER_CALL, METERED_PER_HOUR,
} from '../../../src/server/founder/sources/searchEngines';

/* ------------------------------------------------------------------ fixtures (trimmed real responses) */

const GNEWS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><generator>NFE/5.0</generator><title>""Elizabeth Holmes" lawsuit" - Google News</title><link>https://news.google.com/search?q=%22Elizabeth+Holmes%22+lawsuit&amp;hl=en-US&amp;gl=US&amp;ceid=US:en</link><language>en-US</language><webMaster>news-webmaster@google.com</webMaster><lastBuildDate>Sat, 14 Nov 2026 21:30:39 GMT</lastBuildDate><description>Google News</description>
<item><title>Elizabeth Holmes advocate threatens suing A24 over documentary portrayal - NBC News</title><link>https://news.google.com/rss/articles/CBMivwFBVV95cUxQcFA0S1pwU001VlByRU5hM2FDX3BFTUxIMjFaTDd4TXZjaDlORFl4Mk5jYU5aTXJ5RnU0WEhMZ3RMQVgzY1VmNTRUamgySVhBeE42QTRjNDdmS25hWkVBNG1hTkJFTnlrRmZDV2pUWVpuOXNsVk9zZ2VwemJRRUpPQk4zUktieVEtRFlmcUNDcFZ2SGNyTnJRbHpBY29tTXI5ZTZQSld5akVwZ3pUcENrVmdIUXJoUnVkOWZoNmk1cw?oc=5</link><pubDate>Tue, 27 Oct 2026 07:00:00 GMT</pubDate><source url="https://www.nbcnews.com">NBC News</source></item>
<item><title>Elizabeth Holmes owes over $25 million to Theranos, lawsuit says - CNBC</title><link>https://news.google.com/rss/articles/CBMioAFBVV95cUxOejM3a3k1YjNIZDBKdGhSMF9PSXo1djZCLURiUkppRjBUMEdhaWRKSVZnMFYxQWJRRnc4OFVxSDJBS09zc3VjTG82Zlk2SWIzdzFuN2xpb3ZfUVJzZW5mSjVwVzhWNEljd1NueTNRSnhmbzVUTnJlSFY0dDFoa1lqTnVFSHZyQVRIYmdBZFE2eGQ2UXJ0SzRpTUNhN3Nuc1VT0gGmAUFVX3lxTFBUTnNHa2hBZkVJclc5cUZMSkQ2S1JBaV91c3hXUjJsbk5UVnVfS3pBRGJZbWRDQm5LUVVPYVI5cW5lUUV2c2dCVzByT2c3ZTZrSUxtbzl1eUZPRkF3V05MQUZHT2VERlY2YUpmSjZhV1Blbnp1bDdnXzk3aWFWYW1MSldzX3gyVUd2eFdSYXRMVUtsZEc3QncwZ3dFZ3FjcDlpWlg3Y3c?oc=5</link><pubDate>Fri, 17 Mar 2023 07:00:00 GMT</pubDate><source url="https://www.cnbc.com">CNBC</source></item>
<item><title>Elizabeth Holmes Phones In Her Defense After Civil Lawyers Quit - Bloomberg Law News</title><link>https://news.google.com/rss/articles/CBMiqAFBVV95cUxPTXR1ZFBldGJsRnVVSlI4YVJLUkdIdmNPVUNKZmtDdzZkTThhVm42STQ3TnpWUkc3SkgxdjlkMmdfVEppVkJTVWlyaTFMN3Z2X21KTUltd1BfeHhGenFrVnIxQzQ0UkJocWFNZkxEaEQwT1dibGNrRzFZenR2Y2J3UUktaUw1YTJ2SXdFcW5QY3U3QjlaU2ptLW5QSEdwbnFaZVNtcnpvZ3g?oc=5</link><pubDate>Fri, 24 Jan 2020 08:00:00 GMT</pubDate><source url="https://news.bloomberglaw.com">Bloomberg Law News</source></item>
</channel></rss>`;

const BINGNEWS_XML = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0" xmlns:News="https://www.bing.com/news/search?q=%22Arthur+Mensch%22+Mistral&amp;format=rss"><channel><title>&quot;Arthur Mensch&quot; Mistral - BingNews</title><link>https://www.bing.com/news/search?q=%22Arthur+Mensch%22+Mistral&amp;format=rss</link><description>Search results</description><image><url>http://www.bing.com/rsslogo.gif</url><title>&quot;Arthur Mensch&quot; Mistral</title><link>https://www.bing.com/news/search?q=%22Arthur+Mensch%22+Mistral&amp;format=rss</link></image>
<item><title>Mistral's CEO Arthur Mensch tells BI that DeepSeek is a win for the open-source ecosystem</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=6af8d36eaed34556ae8064a758461284&amp;url=https%3a%2f%2ffinance.yahoo.com%2fnews%2fmistrals-ceo-arthur-mensch-tells-100002020.html&amp;c=6598969524586461793&amp;mkt=en-us</link><description>Mistral's CEO, Arthur Mensch, told BI that DeepSeek is a &quot;great moment for open-source models.&quot; Mistral, a Paris-based startup that uses open-source, is seen as Europe's answer to OpenAI. Mensch said ...</description><pubDate>Sun, 16 Feb 2025 02:00:00 GMT</pubDate><News:Source>Yahoo Finance</News:Source></item>
<item><title>EU leaders told to act now to stay in AI race with US and China</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=6af8d36eaed34556ae8064a758461284&amp;url=https%3a%2f%2fwww.msn.com%2fen-xl%2fnews%2fother%2feu-leaders-told-to-act-now-to-stay-in-ai-race-with-us-and-china%2far-AA2hnAV7&amp;c=17508405387348068432&amp;mkt=en-us</link><description>Mistral CEO Arthur Mensch says Europe has 'all the technology and the talent' to lead the artificial intelligence race The EU must &quot;act now&quot; to ensure Europe stays in the AI race with the US and China ...</description><pubDate>Fri, 13 Nov 2026 09:20:31 GMT</pubDate><News:Source>South China Morning Post on MSN</News:Source></item>
<item><title>Arthur Mensch’s Mistral Is Europe’s Best Bet for Sovereign A.I.</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=6af8d36eaed34556ae8064a758461284&amp;url=https%3a%2f%2fobserver.com%2f2026%2f07%2farthur-menschs-mistral-is-europes-best-bet-for-sovereign-a-i%2f&amp;c=6020420333740847621&amp;mkt=en-us</link><description>CEO Arthur Mensch speaks during the opening keynote of Mistral’s “AI Now Summit” event at the Carrousel du Louvre in Paris on May 28, 2026. STEPHANE DE SAKUTIN / AFP via Getty Images Sovereign A.I. is ...</description><pubDate>Thu, 30 Jul 2026 09:39:00 GMT</pubDate><News:Source>Observer</News:Source></item>
</channel></rss>`;

const BINGNEWS_EMPTY_XML = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0" xmlns:News="https://www.bing.com/news/search?q=%22Elizabeth%20Holmes%22%20lawsuit&amp;format=rss"><channel><title>&quot;Elizabeth Holmes&quot; lawsuit - BingNews</title><link>https://www.bing.com/news/search?q=%22Elizabeth%20Holmes%22%20lawsuit&amp;format=rss</link><description>Search results</description><image><url>http://www.bing.com/rsslogo.gif</url><title>&quot;Elizabeth Holmes&quot; lawsuit</title><link>https://www.bing.com/news/search?q=%22Elizabeth%20Holmes%22%20lawsuit&amp;format=rss</link></image></channel></rss>`;

const GDELT_JSON = `{
 "articles": [
  {
   "url": "https://www.geekwire.com/2018/interview-bad-blood-author-john-carreyrou-elizabeth-holmes-theranos-scandal-not-guide-startups/",
   "url_mobile": "https://www.geekwire.com/2018/interview-bad-blood-author-john-carreyrou-elizabeth-holmes-theranos-scandal-not-guide-startups/amp/",
   "title": "Interview :  Bad Blood  author John Carreyrou on Elizabeth Holmes and the Theranos scandal , a  what not to do  guide for startups – GeekWire",
   "seendate": "20181021T153000Z",
   "socialimage": "",
   "domain": "geekwire.com",
   "language": "English",
   "sourcecountry": "United States"
  },
  {
   "url": "https://chiefexecutive.net/john-carreyrou-theranos-elizabeth-holmes/",
   "url_mobile": "https://chiefexecutive.net/john-carreyrou-theranos-elizabeth-holmes/amp/",
   "title": "John Carreyrou On Theranos , Elizabeth Holmes And Cult Of Personality CEOs",
   "seendate": "20181008T140000Z",
   "socialimage": "",
   "domain": "chiefexecutive.net",
   "language": "English",
   "sourcecountry": "United States"
  },
  {
   "url": "https://gizmodo.com/report-there-may-be-more-criminal-charges-coming-in-th-1829743478",
   "url_mobile": "https://gizmodo.com/report-there-may-be-more-criminal-charges-coming-in-th-1829743478/amp",
   "title": "Report : There May Be More Criminal Charges Coming in the Theranos Investigation",
   "seendate": "20181014T231500Z",
   "socialimage": "",
   "domain": "gizmodo.com",
   "language": "English",
   "sourcecountry": "United States"
  }
 ]
}`;

const DDG_HTML = `<!DOCTYPE html><html><head><title>&quot;Elizabeth Holmes&quot; lawsuit at DuckDuckGo</title></head><body><div class="serp__results"><div id="links" class="results">
<div class="result results_links results_links_deep web-result ">
 <div class="links_main links_deep result__body"> <!-- This is the visible part -->
 <h2 class="result__title">
 <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Fenforcement%2Dlitigation%2Flitigation%2Dreleases%2Flr%2D24069&amp;rut=a8c9744522efdc9c526370668b5071de2633bf92f094db422f2d8e93fbb48432">Elizabeth Holmes, et al. and Ramesh &quot;Sunny&quot; Balwani - SEC.gov</a>
 </h2>
 <div class="result__extras">
 <div class="result__extras__url">
 <span class="result__icon">
 <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Fenforcement%2Dlitigation%2Flitigation%2Dreleases%2Flr%2D24069&amp;rut=a8c9744522efdc9c526370668b5071de2633bf92f094db422f2d8e93fbb48432">
 
 </a>
 </span>
 <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Fenforcement%2Dlitigation%2Flitigation%2Dreleases%2Flr%2D24069&amp;rut=a8c9744522efdc9c526370668b5071de2633bf92f094db422f2d8e93fbb48432">
 www.sec.gov/enforcement-litigation/litigation-releases/lr-24069
 </a>
 </div>
 </div>
 <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Fenforcement%2Dlitigation%2Flitigation%2Dreleases%2Flr%2D24069&amp;rut=a8c9744522efdc9c526370668b5071de2633bf92f094db422f2d8e93fbb48432">On March 14, 2018, the Securities and Exchange Commission charged Silicon Valley-based private company Theranos Inc., its founder and CEO <b>Elizabeth Holmes</b>, and its former President Ramesh &quot;Sunny&quot; Balwani with raising more than $700 million from investors through an elaborate, years-long fraud in which they exaggerated or made false statements about the company&#x27;s technology, business, and ...</a>
 <div class="clear"></div>
 </div>
 </div>
 <div class="result results_links results_links_deep web-result ">
 <div class="links_main links_deep result__body"> <!-- This is the visible part -->
 <h2 class="result__title">
 <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Ffiles%2Flitigation%2Fcomplaints%2F2018%2Fcomp%2Dpr2018%2D41%2Dtheranos%2Dholmes.pdf&amp;rut=b55c6a9bab02302b91fb748cdfd10aa61a0c43e3ec71624db23badab5b4fe06f"><span class="result__type">PDF</span> Elizabeth Holmes and Theranos, Inc. - SEC.gov</a>
 </h2>
 <div class="result__extras">
 <div class="result__extras__url">
 <span class="result__icon">
 <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Ffiles%2Flitigation%2Fcomplaints%2F2018%2Fcomp%2Dpr2018%2D41%2Dtheranos%2Dholmes.pdf&amp;rut=b55c6a9bab02302b91fb748cdfd10aa61a0c43e3ec71624db23badab5b4fe06f">
 
 </a>
 </span>
 <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Ffiles%2Flitigation%2Fcomplaints%2F2018%2Fcomp%2Dpr2018%2D41%2Dtheranos%2Dholmes.pdf&amp;rut=b55c6a9bab02302b91fb748cdfd10aa61a0c43e3ec71624db23badab5b4fe06f">
 www.sec.gov/files/litigation/complaints/2018/comp-pr2018-41-theranos-holmes.pdf
 </a>
 </div>
 </div>
 <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.sec.gov%2Ffiles%2Flitigation%2Fcomplaints%2F2018%2Fcomp%2Dpr2018%2D41%2Dtheranos%2Dholmes.pdf&amp;rut=b55c6a9bab02302b91fb748cdfd10aa61a0c43e3ec71624db23badab5b4fe06f">In 2017, Theranos and Holmes settled a <b>lawsuit</b> with an investor that alleged it was defrauded by Theranos. Theranos also settled a <b>lawsuit</b> with Pharmacy A, which brought an action for breach of contract against the company.</a>
 <div class="clear"></div>
 </div>
 </div>
 </div></div></body></html>`;

const DDG_CHALLENGE_HTML = `<!DOCTYPE html><html><head><title>
        DuckDuckGo
    </title></head><body>
<form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html&cc=botnet" method="POST">
<div class="anomaly-modal__mask">
 <div class="anomaly-modal__modal is-ie" data-testid="anomaly-modal">
 <div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
 <div class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</div>
 <div class="anomaly-modal__instructions">Select all squares containing a duck:</div>
 </div>
</div>
</form></body></html>`;

const BRAVE_HTML = `<!DOCTYPE html><html><head><title>"Elizabeth Holmes" lawsuit - Brave Search</title></head><body><div id="results">
<div class="snippet svelte-jmfu5f" data-pos="0" data-type="web" data-keynav="true"><div class="result-body svelte-1rq4ngz"><div class="result-wrapper svelte-1rq4ngz"><div class="result-content svelte-1rq4ngz"><a href="https://www.justice.gov/usao-ndca/us-v-elizabeth-holmes-et-al" target="_self" class="svelte-14r20fy l1"><div class="site-name-wrapper svelte-on1hvy"><div class="favicon-wrapper svelte-on1hvy"><div class="favicon-background-wrapper svelte-on1hvy"></div>  </div> <div class="site-name-content svelte-on1hvy"><div class="desktop-small-semibold t-secondary text-ellipsis">Department of Justice</div> <div class="url-wrapper svelte-on1hvy"><cite class="snippet-url desktop-small-regular t-tertiary svelte-on1hvy">justice.gov <span class="text-ellipsis">› usao-ndca  › us-v-elizabeth-holmes-et-al</span></cite> </div></div> </div> <div class="title search-snippet-title line-clamp-1 svelte-14r20fy" title="Northern District of California | U.S. v. Elizabeth Holmes, et al.">Northern District of California | U.S. v. Elizabeth Holmes, et al.</div></a> <div class="generic-snippet svelte-1cwdgg3"><div class="content desktop-default-regular t-primary line-clamp-dynamic svelte-1cwdgg3"><span class="t-secondary">December 13, 2022 -</span> On June, 14, 2018, <strong>a grand jury returned an indictment charging Elizabeth Holmes and Ramesh “Sunny” Balwani with crimes in connection with their respective involvement with two multi-million-dollar schemes to promote Theranos</strong>, a private&nbsp;...</div> </div></div> </div> </div>     </div>
<div class="snippet svelte-jmfu5f" data-pos="6" data-type="web" data-keynav="true"><div class="result-body svelte-1rq4ngz"><div class="result-wrapper svelte-1rq4ngz"><div class="result-content svelte-1rq4ngz"><a href="https://en.wikipedia.org/wiki/Elizabeth_Holmes" target="_self" class="svelte-14r20fy l1"><div class="site-name-wrapper svelte-on1hvy"><div class="favicon-wrapper svelte-on1hvy"><div class="favicon-background-wrapper svelte-on1hvy"></div>  </div> <div class="site-name-content svelte-on1hvy"><div class="desktop-small-semibold t-secondary text-ellipsis">Wikipedia</div> <div class="url-wrapper svelte-on1hvy"><cite class="snippet-url desktop-small-regular t-tertiary svelte-on1hvy">en.wikipedia.org <span class="text-ellipsis">› wiki  › Elizabeth_Holmes</span></cite> </div></div> </div> <div class="title search-snippet-title line-clamp-1 svelte-14r20fy" title="Elizabeth Holmes - Wikipedia">Elizabeth Holmes - Wikipedia</div></a> <div class="generic-snippet svelte-1cwdgg3"><div class="content desktop-default-regular t-primary line-clamp-dynamic svelte-1cwdgg3"><span class="t-secondary">1 day ago -</span> ↑ Balakrishnan, Anita (March 23, 2017). "Theranos' <strong>Elizabeth</strong> <strong>Holmes</strong> is giving away her shares to dodge <strong>lawsuits</strong>, report says". CNBC. Archived from the original on 2017-04-11.</div> </div></div> </div> </div> </div></div></div>
</div></body></html>`;

const WIKIPEDIA_JSON = `{
 "batchcomplete": true,
 "query": {
  "searchinfo": {
   "totalhits": 6
  },
  "search": [
   {
    "ns": 0,
    "title": "Arthur Mensch",
    "pageid": 79196161,
    "size": 14988,
    "wordcount": 1224,
    "snippet": "&quot;Rencontre avec <span class=\\"searchmatch\\">Arthur</span> <span class=\\"searchmatch\\">Mensch</span>, prodige français de l&#039;IA et cofondateur de <span class=\\"searchmatch\\">Mistral</span> AI&quot;. Le Point (in French). Retrieved 28 September 2025. &quot;<span class=\\"searchmatch\\">Arthur</span> <span class=\\"searchmatch\\">Mensch</span>, l&#039;ascension",
    "timestamp": "2026-11-12T10:27:40Z"
   },
   {
    "ns": 0,
    "title": "Mistral AI",
    "pageid": 75544367,
    "size": 42595,
    "wordcount": 2831,
    "snippet": "that blows in southern France. <span class=\\"searchmatch\\">Mistral</span> AI was established in April 2023 by three French AI researchers—<span class=\\"searchmatch\\">Arthur</span> <span class=\\"searchmatch\\">Mensch</span>, Guillaume Lample and Timothée Lacroix",
    "timestamp": "2026-11-14T20:46:57Z"
   }
  ]
 }
}`;

/* ------------------------------------------------------------------ helpers */

const MINUTE = 60 * 1000;
const engine = (id) => ENGINES.find((e) => e.id === id);
const hit = (n, extra = {}) => ({ title: `Result ${n} about Jane Roe`, snippet: `Snippet ${n}`, url: `https://example.com/story-${n}`, date: null, ...extra });
const respond = (body, status = 200) => async (url) => ({ status, headers: new Map(), url, text: async () => body });

let now;
/** Replace every engine's search(): an array is its answer, an Error is thrown, a function is called; unlisted engines find nothing. */
function stub(answers = {}) {
  const spies = {};
  for (const e of ENGINES) {
    const answer = answers[e.id];
    spies[e.id] = jest.spyOn(e, 'search').mockImplementation(async (...args) => {
      if (answer === undefined) return [];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(...args) : answer;
    });
  }
  return spies;
}

beforeEach(() => {
  __resetEnginesForTests();
  now = Date.parse('2026-11-14T12:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  delete process.env.FOUNDER_SEARCH_BRAVE_HTML;
  webSearchConfigured.mockReset();
  webSearchConfigured.mockReturnValue(false);
  searchWeb.mockReset();
  searchWeb.mockResolvedValue([]);
});

afterEach(() => {
  jest.restoreAllMocks();
  setTransport();
  delete process.env.FOUNDER_SEARCH_BRAVE_HTML;
});

/* ------------------------------------------------------------------ parsers */

describe('parsers (one per engine, from real samples)', () => {
  test('Google News feed: headline, forwarding link, article date, publisher and its host', () => {
    const results = parseGoogleNews(GNEWS_XML);
    expect(results).toHaveLength(3);
    expect(results[1]).toEqual({
      title: 'Elizabeth Holmes owes over $25 million to Theranos, lawsuit says - CNBC',
      snippet: '',
      url: expect.stringMatching(/^https:\/\/news\.google\.com\/rss\/articles\/CBMioAFBVV95cUxOejM3a3k1[\w-]+\?oc=5$/),
      date: '2023-03-17',
      publisher: 'CNBC',
      host: 'cnbc.com',
    });
    expect(results.map((r) => r.date)).toEqual(['2026-10-27', '2023-03-17', '2020-01-24']);
    expect(results[2].host).toBe('news.bloomberglaw.com');
  });

  test('Google News: a page instead of a feed is a block', () => {
    expect(() => parseGoogleNews('<html><head><title>Sorry...</title></head><body>Our systems have detected unusual traffic</body></html>')).toThrow(EngineBlocked);
  });

  test('Bing News feed: headline, sentence, unwrapped article link, date, publisher', () => {
    const results = parseBingNews(BINGNEWS_XML);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: "Mistral's CEO Arthur Mensch tells BI that DeepSeek is a win for the open-source ecosystem",
      snippet: expect.stringMatching(/^Mistral's CEO, Arthur Mensch, told BI that DeepSeek is a "great moment for open-source models\."/),
      url: 'https://finance.yahoo.com/news/mistrals-ceo-arthur-mensch-tells-100002020.html',
      date: '2025-02-16',
      publisher: 'Yahoo Finance',
    });
    expect(results[2].url).toBe('https://observer.com/2026/07/arthur-menschs-mistral-is-europes-best-bet-for-sovereign-a-i/');
    expect(results[2].date).toBe('2026-07-30');
  });

  test('Bing News: an empty feed is "found nothing", a page is a block', () => {
    expect(parseBingNews(BINGNEWS_EMPTY_XML)).toEqual([]);
    expect(() => parseBingNews('<!DOCTYPE html><html><body>captcha</body></html>')).toThrow(EngineBlocked);
  });

  test('GDELT article list: tidied headline, first-seen date, source site', () => {
    const results = parseGdelt(GDELT_JSON);
    expect(results).toHaveLength(3);
    expect(results[1]).toEqual({
      title: 'John Carreyrou On Theranos, Elizabeth Holmes And Cult Of Personality CEOs',
      snippet: '',
      url: 'https://chiefexecutive.net/john-carreyrou-theranos-elizabeth-holmes/',
      date: '2018-10-08',
      publisher: 'chiefexecutive.net',
    });
    expect(results[0].title).toMatch(/^Interview: Bad Blood author John Carreyrou on Elizabeth Holmes and the Theranos scandal, a what not to do guide/);
  });

  test('GDELT: its plain-text notices are a block (slow down) or a failure (anything else); no matches is an empty list', () => {
    expect(() => parseGdelt('Please limit requests to one every 5 seconds or contact kalev.leetaru5@gmail.com for larger queries.')).toThrow(EngineBlocked);
    let error = null;
    try { parseGdelt('The specified phrase is too short.'); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error);
    expect(error.blocked).toBeUndefined();
    expect(parseGdelt('{}')).toEqual([]);
  });

  test('DuckDuckGo results page: title, snippet text, and the real address behind its redirect', () => {
    const results = parseDuckDuckGo(DDG_HTML);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Elizabeth Holmes, et al. and Ramesh "Sunny" Balwani - SEC.gov',
      snippet: expect.stringContaining('its founder and CEO Elizabeth Holmes, and its former President Ramesh "Sunny" Balwani with raising more than $700 million'),
      url: 'https://www.sec.gov/enforcement-litigation/litigation-releases/lr-24069',
      date: null,
    });
    expect(results[1].url).toBe('https://www.sec.gov/files/litigation/complaints/2018/comp-pr2018-41-theranos-holmes.pdf');
    expect(results[1].snippet).toMatch(/^In 2017, Theranos and Holmes settled a lawsuit with an investor/);
  });

  test('DuckDuckGo: the "bots use DuckDuckGo too" challenge is a block, an empty results page is not', () => {
    expect(() => parseDuckDuckGo(DDG_CHALLENGE_HTML)).toThrow(EngineBlocked);
    expect(parseDuckDuckGo('<html><head><title>zzqx at DuckDuckGo</title></head><body><div class="serp__results"><div id="links" class="results"><div class="no-results">No results.</div></div></div></body></html>')).toEqual([]);
  });

  test('Brave results page: title, address, snippet without its leading date, and that date', () => {
    const results = parseBrave(BRAVE_HTML, Date.parse('2026-11-14T12:00:00Z'));
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Northern District of California | U.S. v. Elizabeth Holmes, et al.',
      snippet: expect.stringMatching(/^On June, 14, 2018, a grand jury returned an indictment charging Elizabeth Holmes and Ramesh “Sunny” Balwani/),
      url: 'https://www.justice.gov/usao-ndca/us-v-elizabeth-holmes-et-al',
      date: '2022-12-13',
    });
    expect(results[1]).toMatchObject({ title: 'Elizabeth Holmes - Wikipedia', url: 'https://en.wikipedia.org/wiki/Elizabeth_Holmes', date: '2026-11-13' });
    expect(results[1].snippet).not.toMatch(/1 day ago/);
  });

  test('Brave: a page that is not a results page is a block', () => {
    expect(() => parseBrave('<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>')).toThrow(EngineBlocked);
    expect(parseBrave('<html><head><title>zzqx - Brave Search</title></head><body><div id="results"></div></body></html>')).toEqual([]);
  });

  test('Wikipedia search: article title, snippet without markup, article address, no date', () => {
    const results = parseWikipedia(JSON.parse(WIKIPEDIA_JSON));
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Arthur Mensch - Wikipedia',
      snippet: expect.stringMatching(/^"Rencontre avec Arthur Mensch, prodige français de l'IA et cofondateur de Mistral AI"\. Le Point \(in French\)/),
      url: 'https://en.wikipedia.org/wiki/Arthur_Mensch',
      date: null,
    });
    expect(results[1].url).toBe('https://en.wikipedia.org/wiki/Mistral_AI');
    expect(results[1].snippet).toContain('three French AI researchers—Arthur Mensch, Guillaume Lample and Timothée Lacroix');
    expect(parseWikipedia({ batchcomplete: true, query: { search: [] } })).toEqual([]);
    expect(() => parseWikipedia({ error: { code: 'ratelimited', info: 'Too many requests' } })).toThrow(/Too many requests/);
  });
});

/* ------------------------------------------------------------------ how each engine is asked */

describe('how a query is put to each engine', () => {
  const capture = (body) => {
    const calls = [];
    setTransport(async (url, init) => { calls.push({ url: new URL(url), init }); return { status: 200, headers: new Map(), url, text: async () => body }; });
    return calls;
  };

  test('every engine has an id, a kind and a search function; ids are unique', () => {
    expect(ENGINES.map((e) => e.id)).toEqual(['ddg', 'brave', 'gnews', 'bingnews', 'wikipedia', 'gdelt']);
    for (const e of ENGINES) {
      expect(['web', 'news']).toContain(e.kind);
      expect(typeof e.search).toBe('function');
      expect(typeof e.label).toBe('string');
    }
    expect(MAX_ENGINES_PER_CALL).toBe(3);
  });

  test('Google News: a date window is written as after: and before: (both), and the edition follows the language', async () => {
    const calls = capture(GNEWS_XML);
    const results = await engine('gnews').search('"Elizabeth Holmes" Theranos', { after: '2015-01-01', before: '2017-01-01', deadline: now + 10000 });
    expect(results).toHaveLength(3);
    expect(calls[0].url.origin + calls[0].url.pathname).toBe('https://news.google.com/rss/search');
    expect(calls[0].url.searchParams.get('q')).toBe('"Elizabeth Holmes" Theranos after:2015-01-01 before:2017-01-01');
    expect(calls[0].url.searchParams.get('ceid')).toBe('US:en');
    expect(calls[0].init.headers['User-Agent']).toMatch(/diligence-research/); // asked as what we are

    await engine('gnews').search('"Arthur Mensch" (procès OR fraude)', { lang: 'fr', deadline: now + 10000 });
    expect(calls[1].url.searchParams.get('q')).toBe('"Arthur Mensch" (procès OR fraude)');
    expect(calls[1].url.searchParams.get('ceid')).toBe('FR:fr');

    await engine('gnews').search('"Jane Roe"', { before: '2014-01-01', deadline: now + 10000 });
    expect(calls[2].url.searchParams.get('q')).toBe('"Jane Roe" after:1990-01-01 before:2014-01-01');
  });

  test('DuckDuckGo: no parentheses, site: reduced to the host, date limits as df', async () => {
    const calls = capture(DDG_HTML);
    await engine('ddg').search('"Arthur Mensch" Mistral site:linkedin.com/in', { deadline: now + 10000 });
    expect(calls[0].url.origin + calls[0].url.pathname).toBe('https://html.duckduckgo.com/html/');
    expect(calls[0].url.searchParams.get('q')).toBe('"Arthur Mensch" Mistral site:linkedin.com');
    expect(calls[0].url.searchParams.get('df')).toBeNull();
  });

  test('DuckDuckGo: OR groups and date limits', async () => {
    const calls = capture(DDG_HTML);
    await engine('ddg').search('"Jane Roe" (site:reddit.com OR site:news.ycombinator.com)', { withinDays: 30, deadline: now + 10000 });
    expect(calls[0].url.searchParams.get('q')).toBe('"Jane Roe" site:reddit.com OR site:news.ycombinator.com');
    expect(calls[0].url.searchParams.get('df')).toBe('m');
  });

  test('DuckDuckGo: an explicit window and a region', async () => {
    const calls = capture(DDG_HTML);
    await engine('ddg').search('"Jane Roe" lawsuit', { after: '2015-01-01', before: '2017-01-01', lang: 'de', deadline: now + 10000 });
    expect(calls[0].url.searchParams.get('df')).toBe('2015-01-01..2017-01-01');
    expect(calls[0].url.searchParams.get('kl')).toBe('de-de');
  });

  test('Bing News asks for the RSS format; Wikipedia asks the search list of the right language edition', async () => {
    let calls = capture(BINGNEWS_XML);
    await engine('bingnews').search('"Arthur Mensch" Mistral', { deadline: now + 10000 });
    expect(calls[0].url.origin + calls[0].url.pathname).toBe('https://www.bing.com/news/search');
    expect(calls[0].url.searchParams.get('format')).toBe('rss');
    expect(calls[0].url.searchParams.get('q')).toBe('"Arthur Mensch" Mistral');

    calls = capture(WIKIPEDIA_JSON);
    const results = await engine('wikipedia').search('"Arthur Mensch" (founder OR CEO)', { lang: 'fr', num: 5, deadline: now + 10000 });
    expect(calls[0].url.hostname).toBe('fr.wikipedia.org');
    expect(calls[0].url.searchParams.get('srsearch')).toBe('"Arthur Mensch" founder OR CEO');
    expect(calls[0].url.searchParams.get('srlimit')).toBe('5');
    expect(results[0].url).toBe('https://fr.wikipedia.org/wiki/Arthur_Mensch');
  });

  test('GDELT: short bare words are dropped, and a window is clamped to where its coverage starts', async () => {
    const calls = capture(GDELT_JSON);
    await engine('gdelt').search('"Jane Roe" (CV OR resume OR "curriculum vitae")', { after: '2010-01-01', before: '2020-01-01', deadline: now + 30000 });
    const p = calls[0].url.searchParams;
    expect(p.get('query')).toBe('"Jane Roe" (resume OR "curriculum vitae")');
    expect(p.get('mode')).toBe('artlist');
    expect(p.get('format')).toBe('json');
    expect(p.get('startdatetime')).toBe('20170101000000');
    expect(p.get('enddatetime')).toBe('20200101000000');
  });

  test('query helpers', () => {
    expect(withoutShortWords('"Jane Roe" AI')).toBe('"Jane Roe"');
    expect(withoutShortWords('"Jane Roe" (SEC OR FTC OR UK)')).toBe('"Jane Roe" (SEC OR FTC)');
    expect(siteFilters('"Jane Roe" site:linkedin.com/in')).toEqual([{ host: 'linkedin.com', path: '/in' }]);
    expect(siteFilters('"Jane Roe" (site:reddit.com OR site:news.ycombinator.com) -site:pinterest.com')).toEqual([{ host: 'reddit.com', path: '' }, { host: 'news.ycombinator.com', path: '' }]);
  });
});

/* ------------------------------------------------------------------ which engines, in which order */

describe('engine order', () => {
  test('a web search: DuckDuckGo, then the news feeds, then Wikipedia (Brave is off unless switched on)', () => {
    expect(engineOrder({ query: '"Jane Roe" lawsuit' })).toEqual(['ddg', 'gnews', 'bingnews', 'wikipedia']);
    process.env.FOUNDER_SEARCH_BRAVE_HTML = '1';
    expect(engineOrder({ query: '"Jane Roe" lawsuit' })).toEqual(['ddg', 'brave', 'gnews', 'bingnews', 'wikipedia']);
  });

  test('a "who is this" search prefers Wikipedia to headlines', () => {
    expect(engineOrder({ query: '"Jane Roe" Acme', prefer: 'reference' })).toEqual(['ddg', 'wikipedia', 'gnews', 'bingnews']);
  });

  test('a news search: Google News, Bing News, GDELT; engines that cannot serve the window are left out', () => {
    expect(engineOrder({ news: true, query: '"Jane Roe"' })).toEqual(['gnews', 'bingnews', 'gdelt']);
    expect(engineOrder({ news: true, query: '"Jane Roe"', after: '2018-01-01', before: '2021-01-01' })).toEqual(['gnews', 'gdelt']);
    expect(engineOrder({ news: true, query: '"Jane Roe"', after: '2005-01-01', before: '2016-01-01' })).toEqual(['gnews']);
    expect(engineOrder({ query: '"Jane Roe"', after: '2005-01-01', before: '2016-01-01' })).toEqual(['ddg', 'gnews']);
  });

  test('a search restricted to a site only goes to engines that can restrict', () => {
    expect(engineOrder({ query: '"Jane Roe" site:linkedin.com/in' })).toEqual(['ddg']);
    expect(engineOrder({ news: true, query: '"Jane Roe" site:reuters.com' })).toEqual(['gnews']);
  });
});

describe('keylessSearch: fallback', () => {
  test('stops at the first engine that returns results', async () => {
    const spies = stub({ ddg: [hit(1), hit(2)], gnews: [hit(3)] });
    const out = await keylessSearch('"Jane Roe" lawsuit');
    expect(out.engine).toBe('ddg');
    expect(out.results.map((r) => r.url)).toEqual(['https://example.com/story-1', 'https://example.com/story-2']);
    expect(out.tried).toEqual([{ id: 'ddg', outcome: 'results', count: 2 }]);
    expect(spies.gnews).not.toHaveBeenCalled();
    expect(spies.ddg).toHaveBeenCalledWith('"Jane Roe" lawsuit', expect.objectContaining({ num: 10 }));
  });

  test('falls through to the next engine when one finds nothing or fails', async () => {
    const spies = stub({ ddg: [], gnews: new Error('socket hang up'), bingnews: [hit(7)] });
    const out = await keylessSearch('"Jane Roe" lawsuit');
    expect(out.engine).toBe('bingnews');
    expect(out.tried).toEqual([
      { id: 'ddg', outcome: 'nothing', count: 0 },
      { id: 'gnews', outcome: 'failed', error: 'socket hang up' },
      { id: 'bingnews', outcome: 'results', count: 1 },
    ]);
    expect(spies.wikipedia).not.toHaveBeenCalled();
  });

  test('asks at most three engines per call, and resolves empty (does not throw) when they simply found nothing', async () => {
    const spies = stub({});
    const out = await keylessSearch('"Jane Roe" lawsuit');
    expect(out).toEqual({ results: [], engine: null, tried: [{ id: 'ddg', outcome: 'nothing', count: 0 }, { id: 'gnews', outcome: 'nothing', count: 0 }, { id: 'bingnews', outcome: 'nothing', count: 0 }] });
    expect(spies.wikipedia).not.toHaveBeenCalled();
  });

  test('prefer: reference asks Wikipedia before the news feeds', async () => {
    const spies = stub({ ddg: [], wikipedia: [hit(1)], gnews: [hit(2)] });
    const out = await keylessSearch('"Jane Roe" Acme', { prefer: 'reference' });
    expect(out.engine).toBe('wikipedia');
    expect(spies.gnews).not.toHaveBeenCalled();
  });

  test('Brave is asked second when the deployment switches it on, never otherwise', async () => {
    let spies = stub({ ddg: [], brave: [hit(1)] });
    let out = await keylessSearch('"Jane Roe" lawsuit');
    expect(spies.brave).not.toHaveBeenCalled();
    expect(out.results).toEqual([]);
    jest.restoreAllMocks();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    process.env.FOUNDER_SEARCH_BRAVE_HTML = '1';
    spies = stub({ ddg: [], brave: [hit(1)] });
    out = await keylessSearch('"Jane Roe" lawsuit');
    expect(out.engine).toBe('brave');
  });

  test('a news search goes Google News then Bing News; the slow GDELT index is only asked when neither answered', async () => {
    let spies = stub({ gnews: [], bingnews: [] });
    let out = await keylessSearch('"Jane Roe" fraud', { news: true });
    expect(out.tried.map((t) => t.id)).toEqual(['gnews', 'bingnews']);
    expect(spies.gdelt).not.toHaveBeenCalled();
    expect(out.results).toEqual([]);

    jest.restoreAllMocks();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    spies = stub({ gnews: new Error('timeout'), bingnews: new Error('timeout'), gdelt: [hit(4, { date: '2026-10-01' })] });
    out = await keylessSearch('"Jane Roe" fraud', { news: true });
    expect(out.engine).toBe('gdelt');
    expect(out.results[0].date).toBe('2026-10-01');
  });

  test('passes the window and language through, and drops results dated outside the window', async () => {
    const spies = stub({ gnews: [hit(1, { date: '2016-03-01' }), hit(2, { date: '2021-06-01' }), hit(3, { date: null })] });
    const out = await keylessSearch('"Jane Roe"', { news: true, after: '2015-01-01', before: '2017-01-01', lang: 'fr', num: 15 });
    expect(spies.gnews).toHaveBeenCalledWith('"Jane Roe"', expect.objectContaining({ after: '2015-01-01', before: '2017-01-01', lang: 'fr', num: 15 }));
    expect(out.results.map((r) => r.url)).toEqual(['https://example.com/story-1', 'https://example.com/story-3']);
  });

  test('a site-restricted search is only put to engines that can restrict, and off-site results are dropped', async () => {
    const spies = stub({
      ddg: [
        hit(1, { url: 'https://fr.linkedin.com/in/jane-roe/fr' }),
        hit(2, { url: 'https://www.linkedin.com/pub/dir/jane/roe' }),
        hit(3, { url: 'https://www.linkedin.com/in/jane-roe-352307170' }),
        hit(4, { url: 'https://example.com/jane-roe' }),
      ],
      gnews: [hit(9)],
    });
    const out = await keylessSearch('"Jane Roe" Acme site:linkedin.com/in');
    expect(out.results.map((r) => r.url)).toEqual(['https://fr.linkedin.com/in/jane-roe/fr', 'https://www.linkedin.com/in/jane-roe-352307170']);
    expect(spies.gnews).not.toHaveBeenCalled();
  });

  test('de-duplicates by address and by syndicated headline, keeps at most num', async () => {
    stub({
      ddg: [
        hit(1, { url: 'https://www.example.com/story-1/' }),
        hit(1, { url: 'http://example.com/story-1?utm_source=x' }),
        hit(2, { title: 'You Can See Everything: Trailer released for Elizabeth Holmes documentary', url: 'https://www.fox4news.com/a' }),
        hit(3, { title: 'You Can See Everything: Trailer released for Elizabeth Holmes documentary', url: 'https://www.fox29.com/b' }),
        hit(4), hit(5), hit(6),
      ],
    });
    const out = await keylessSearch('"Jane Roe"', { num: 3 });
    expect(out.results.map((r) => r.url)).toEqual(['https://www.example.com/story-1/', 'https://www.fox4news.com/a', 'https://example.com/story-4']);
  });

  test('drops people-search and data-broker hosts, also behind a forwarding link', async () => {
    stub({
      ddg: [
        hit(1, { url: 'https://www.spokeo.com/Jane-Roe' }),
        hit(2, { url: 'https://radaris.com/p/Jane/Roe/' }),
        hit(3, { url: 'https://news.google.com/rss/articles/abc?oc=5', host: 'legacy.com' }),
        hit(4, { url: 'ftp://example.com/x' }),
        hit(5),
      ],
    });
    const out = await keylessSearch('"Jane Roe"');
    expect(out.results.map((r) => r.url)).toEqual(['https://example.com/story-5']);
  });

  test('accept: an engine whose results are all rejected counts as having found nothing', async () => {
    const spies = stub({
      ddg: [hit(1, { title: 'Unrelated headline', snippet: 'nothing here' })],
      gnews: [hit(2, { title: 'Unrelated again', snippet: '' }), hit(3, { title: 'Jane Roe sued by investors', snippet: '' })],
    });
    const out = await keylessSearch('"Jane Roe" lawsuit', { accept: (r) => /Jane Roe/.test(`${r.title} ${r.snippet}`) });
    expect(out.engine).toBe('gnews');
    expect(out.results.map((r) => r.title)).toEqual(['Jane Roe sued by investors']);
    expect(out.tried[0]).toEqual({ id: 'ddg', outcome: 'nothing', count: 0 });
    expect(spies.gnews).toHaveBeenCalledTimes(1);
  });

  test('an empty query asks nobody', async () => {
    const spies = stub({ ddg: [hit(1)] });
    expect(await keylessSearch('   ')).toEqual({ results: [], engine: null, tried: [] });
    expect(spies.ddg).not.toHaveBeenCalled();
  });

  test('throws only when every engine failed', async () => {
    stub({ ddg: new Error('boom'), gnews: new Error('boom'), bingnews: new Error('boom'), wikipedia: [hit(1)] });
    await expect(keylessSearch('"Jane Roe" lawsuit')).rejects.toThrow(/No search engine answered \(DuckDuckGo: did not answer; Google News: did not answer; Bing News: did not answer\)/);
  });
});

/* ------------------------------------------------------------------ health: cooldowns and allowances */

describe('keylessSearch: cooldown after a block', () => {
  const ddgState = () => engineHealth().engines.find((e) => e.id === 'ddg');

  test('a challenge page puts the engine in cooldown for 10 minutes; it is skipped meanwhile', async () => {
    const spies = stub({ ddg: new EngineBlocked('DuckDuckGo asked for a human check'), gnews: [hit(1)] });
    const first = await keylessSearch('"Jane Roe" lawsuit');
    expect(first.engine).toBe('gnews');
    expect(first.tried[0]).toEqual({ id: 'ddg', outcome: 'blocked', error: 'DuckDuckGo asked for a human check' });
    expect(ddgState()).toMatchObject({ state: 'paused', blocks: 1, pausedUntil: new Date(now + 10 * MINUTE).toISOString() });

    now += 9 * MINUTE;
    const second = await keylessSearch('"Jane Roe" fraud');
    expect(second.tried[0]).toEqual({ id: 'ddg', outcome: 'paused' });
    expect(second.engine).toBe('gnews');
    expect(spies.ddg).toHaveBeenCalledTimes(1);

    now += 2 * MINUTE; // 11 minutes after the block
    await keylessSearch('"Jane Roe" scam');
    expect(spies.ddg).toHaveBeenCalledTimes(2);
  });

  test('each further block doubles the cooldown, up to 2 hours; an answer resets it', async () => {
    let blocked = true;
    stub({ ddg: () => { if (blocked) throw new EngineBlocked('challenge'); return [hit(1)]; }, gnews: [hit(2)] });
    const seen = [];
    for (let i = 0; i < 6; i += 1) {
      await keylessSearch(`"Jane Roe" q${i}`);
      const until = Date.parse(ddgState().pausedUntil);
      seen.push((until - now) / MINUTE);
      now = until + 1000;
    }
    expect(seen).toEqual([10, 20, 40, 80, 120, 120]);

    blocked = false;
    const ok = await keylessSearch('"Jane Roe" ok');
    expect(ok.engine).toBe('ddg');
    expect(ddgState().state).toBe('ok');
    blocked = true;
    now += 11 * MINUTE;
    await keylessSearch('"Jane Roe" again');
    expect((Date.parse(ddgState().pausedUntil) - now) / MINUTE).toBe(10);
  });

  test('HTTP 429 and 403 are blocks too; a plain failure is not, until it happens three times running', async () => {
    const tooMany = Object.assign(new Error('HTTP 429'), { status: 429 });
    const forbidden = Object.assign(new Error('HTTP 403'), { status: 403 });
    const spies = stub({ gnews: tooMany, bingnews: forbidden, gdelt: new Error('Timed out after 22s') });
    await expect(keylessSearch('"Jane Roe"', { news: true })).rejects.toThrow(/Google News: asked us to slow down; Bing News: asked us to slow down; GDELT news index: did not answer/);
    const byId = Object.fromEntries(engineHealth().engines.map((e) => [e.id, e]));
    expect(byId.gnews.state).toBe('paused');
    expect(byId.bingnews.state).toBe('paused');
    expect(byId.gdelt).toMatchObject({ state: 'ok', failures: 1, lastError: 'Timed out after 22s' });

    // two more plain failures: then a five-minute rest
    await expect(keylessSearch('"Jane Roe" a', { news: true })).rejects.toThrow();
    await expect(keylessSearch('"Jane Roe" b', { news: true })).rejects.toThrow();
    expect(spies.gdelt).toHaveBeenCalledTimes(3);
    expect(engineHealth().engines.find((e) => e.id === 'gdelt').state).toBe('paused');
    await expect(keylessSearch('"Jane Roe" c', { news: true })).rejects.toThrow(/GDELT news index: paused/);
    expect(spies.gdelt).toHaveBeenCalledTimes(3);
    now += 5 * MINUTE + 1000;
    await expect(keylessSearch('"Jane Roe" d', { news: true })).rejects.toThrow();
    expect(spies.gdelt).toHaveBeenCalledTimes(4);
  });

  test('through the real client: Google News answering 429 is paused and Bing News takes over', async () => {
    setTransport(async (url) => {
      if (url.includes('news.google.com')) return { status: 429, headers: new Map(), url, text: async () => 'Too Many Requests' };
      return { status: 200, headers: new Map(), url, text: async () => BINGNEWS_XML };
    });
    const out = await keylessSearch('"Arthur Mensch" Mistral', { news: true, deadline: now + 20000 });
    expect(out.engine).toBe('bingnews');
    expect(out.tried[0]).toMatchObject({ id: 'gnews', outcome: 'blocked' });
    expect(out.results).toHaveLength(3);
    expect(out.results[0]).toMatchObject({ url: 'https://finance.yahoo.com/news/mistrals-ceo-arthur-mensch-tells-100002020.html', date: '2025-02-16', publisher: 'Yahoo Finance' });
    expect(engineHealth().engines.find((e) => e.id === 'gnews').state).toBe('paused');
  });

  test('through the real client: a DuckDuckGo challenge page (HTTP 202) is a block, and the news feed answers instead', async () => {
    setTransport(async (url) => {
      if (url.includes('duckduckgo.com')) return { status: 202, headers: new Map(), url, text: async () => DDG_CHALLENGE_HTML };
      if (url.includes('news.google.com')) return { status: 200, headers: new Map(), url, text: async () => GNEWS_XML };
      return { status: 500, headers: new Map(), url, text: async () => '' };
    });
    const out = await keylessSearch('"Elizabeth Holmes" lawsuit', { deadline: now + 20000 });
    expect(out.tried[0]).toMatchObject({ id: 'ddg', outcome: 'blocked' });
    expect(out.engine).toBe('gnews');
    expect(out.results[0]).toMatchObject({ title: 'Elizabeth Holmes advocate threatens suing A24 over documentary portrayal - NBC News', host: 'nbcnews.com', publisher: 'NBC News', date: '2026-10-27' });
  });
});

describe('keylessSearch: allowances', () => {
  test('DuckDuckGo takes four general searches per ten minutes and keeps two for site-restricted ones', async () => {
    const spies = stub({ ddg: [hit(1)], gnews: [hit(2)] });
    for (let i = 0; i < 4; i += 1) expect((await keylessSearch(`"Jane Roe" q${i}`)).engine).toBe('ddg');
    const fifth = await keylessSearch('"Jane Roe" q5');
    expect(fifth.tried[0]).toEqual({ id: 'ddg', outcome: 'resting' });
    expect(fifth.engine).toBe('gnews');

    spies.ddg.mockImplementation(async () => [hit(1, { url: 'https://www.linkedin.com/in/jane-roe' })]);
    expect((await keylessSearch('"Jane Roe" site:linkedin.com/in')).engine).toBe('ddg');
    expect((await keylessSearch('"Jane Roe" Acme site:linkedin.com/in')).engine).toBe('ddg');
    // the allowance is used up: nobody else can restrict to a site, so the search could not be made
    await expect(keylessSearch('"Jane Roe" site:reddit.com')).rejects.toThrow(/No search engine answered \(DuckDuckGo: resting/);
    expect(spies.ddg).toHaveBeenCalledTimes(6);
    expect(engineHealth().engines.find((e) => e.id === 'ddg').state).toBe('resting');

    now += 10 * MINUTE + 1000;
    expect((await keylessSearch('"Jane Roe" site:reddit.com')).tried[0].id).toBe('ddg');
    expect(spies.ddg).toHaveBeenCalledTimes(7);
  });

  test('an engine is not asked when the call has no time left for it', async () => {
    const spies = stub({ ddg: [hit(1)] });
    await expect(keylessSearch('"Jane Roe"', { deadline: now + 1000 })).rejects.toThrow(/DuckDuckGo: busy/);
    expect(spies.ddg).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ the metered last resort */

describe('keylessSearch: metered fallback', () => {
  const metered = [{ title: 'Jane Roe - Acme | LinkedIn', snippet: 'Founder at Acme', content: 'Founder at Acme', url: 'https://www.linkedin.com/in/jane-roe', date: null }];

  test('is used only when allowed, configured, and every keyless engine failed or found nothing', async () => {
    webSearchConfigured.mockReturnValue(true);
    searchWeb.mockResolvedValue(metered);
    stub({});

    // not allowed
    expect((await keylessSearch('"Jane Roe" Acme')).results).toEqual([]);
    expect(searchWeb).not.toHaveBeenCalled();

    // allowed, engines found nothing
    const out = await keylessSearch('"Jane Roe" Acme', { allowMetered: true, num: 8 });
    expect(searchWeb).toHaveBeenCalledTimes(1);
    expect(searchWeb).toHaveBeenCalledWith('"Jane Roe" Acme', { news: false, withinDays: 0, num: 8 });
    expect(out.engine).toBe('metered');
    expect(out.results).toEqual([{ title: 'Jane Roe - Acme | LinkedIn', snippet: 'Founder at Acme', url: 'https://www.linkedin.com/in/jane-roe', date: null }]);
    expect(out.tried[out.tried.length - 1]).toEqual({ id: 'metered', outcome: 'results', count: 1 });
  });

  test('is not used when a keyless engine returned results, or when it is not configured', async () => {
    webSearchConfigured.mockReturnValue(true);
    searchWeb.mockResolvedValue(metered);
    stub({ ddg: [hit(1)] });
    expect((await keylessSearch('"Jane Roe" Acme', { allowMetered: true })).engine).toBe('ddg');
    expect(searchWeb).not.toHaveBeenCalled();

    jest.restoreAllMocks();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    webSearchConfigured.mockReturnValue(false);
    stub({});
    expect((await keylessSearch('"Jane Roe" Acme', { allowMetered: true })).results).toEqual([]);
    expect(searchWeb).not.toHaveBeenCalled();
  });

  test('rescues a search that every keyless engine failed; when it fails too the search rejects', async () => {
    webSearchConfigured.mockReturnValue(true);
    searchWeb.mockResolvedValue(metered);
    stub({ ddg: new Error('boom'), gnews: new Error('boom'), bingnews: new Error('boom') });
    const out = await keylessSearch('"Jane Roe" Acme', { allowMetered: true });
    expect(out.engine).toBe('metered');

    searchWeb.mockRejectedValue(new Error('quota exceeded'));
    await expect(keylessSearch('"Jane Roe" Acme', { allowMetered: true })).rejects.toThrow(/the backup search service: did not answer/);
  });

  test('at most 20 metered calls an hour per server instance', async () => {
    webSearchConfigured.mockReturnValue(true);
    searchWeb.mockResolvedValue(metered);
    stub({});
    expect(METERED_PER_HOUR).toBe(20);
    for (let i = 0; i < 24; i += 1) {
      const out = await keylessSearch(`"Jane Roe" q${i}`, { allowMetered: true });
      expect(out.engine).toBe(i < 20 ? 'metered' : null);
      now += MINUTE;
    }
    expect(searchWeb).toHaveBeenCalledTimes(20);
    expect(engineHealth().metered).toEqual({ configured: true, usedThisHour: 20, hourlyLimit: 20 });

    now += 40 * MINUTE; // the first calls are now more than an hour old
    expect((await keylessSearch('"Jane Roe" later', { allowMetered: true })).engine).toBe('metered');
    expect(searchWeb).toHaveBeenCalledTimes(21);
  });

  test('is never used for a past date window (it cannot search one), and its results obey the same filters', async () => {
    webSearchConfigured.mockReturnValue(true);
    searchWeb.mockResolvedValue([{ title: 'Jane Roe', snippet: 'x', url: 'https://www.spokeo.com/Jane-Roe' }, ...metered]);
    stub({});
    expect((await keylessSearch('"Jane Roe"', { news: true, after: '2015-01-01', before: '2017-01-01', allowMetered: true })).results).toEqual([]);
    expect(searchWeb).not.toHaveBeenCalled();

    const out = await keylessSearch('"Jane Roe"', { allowMetered: true });
    expect(out.results.map((r) => r.url)).toEqual(['https://www.linkedin.com/in/jane-roe']);
  });
});

/* ------------------------------------------------------------------ health report */

describe('engineHealth', () => {
  test('reports each engine and resets cleanly', async () => {
    stub({ ddg: [hit(1), hit(2)] });
    await keylessSearch('"Jane Roe"');
    let health = engineHealth();
    expect(health.engines.map((e) => e.id)).toEqual(['ddg', 'brave', 'gnews', 'bingnews', 'wikipedia', 'gdelt']);
    expect(health.engines[0]).toMatchObject({ id: 'ddg', label: 'DuckDuckGo', kind: 'web', state: 'ok', calls: 1, answers: 1, results: 2, blocks: 0, failures: 0, pausedUntil: null });
    expect(health.engines[1]).toMatchObject({ id: 'brave', state: 'off' });
    expect(health.metered).toEqual({ configured: false, usedThisHour: 0, hourlyLimit: 20 });
    expect(health.note).toBe('Open-web and news searches ran on DuckDuckGo, Google News, Bing News, Wikipedia, GDELT news index.');
    expect(health.note).not.toMatch(/\b(API|endpoint|free|paid|key|token)\b/i);

    __resetEnginesForTests();
    health = engineHealth();
    expect(health.engines[0]).toMatchObject({ calls: 0, answers: 0, results: 0 });
  });

  test('says which engines are paused', async () => {
    stub({ ddg: new EngineBlocked('challenge'), gnews: [hit(1)] });
    await keylessSearch('"Jane Roe"');
    expect(engineHealth().note).toMatch(/DuckDuckGo asked for fewer searches and is paused for now; the others covered\./);
  });
});
