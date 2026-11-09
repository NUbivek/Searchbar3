/**
 * Source groups: Government & regulators, Patents & IP, Institutions &
 * research as site-restricted searches, tiered by host.
 */
const { SOURCE_GROUPS, SOURCE_GROUP_KEYS, groupQueries, hostInGroup, groupOfUrl } = require('../../../src/utils/sources/sourceGroups');
const { sourceTier, isVerifiedSource } = require('../../../src/utils/sourceTiers');
const { normalizeSources } = require('../../../src/pages/api/search/open');

describe('source groups', () => {
  test('three groups, each with a label, hint, tier and domains', () => {
    expect(SOURCE_GROUP_KEYS).toEqual(['government', 'ip', 'institutions']);
    for (const g of Object.values(SOURCE_GROUPS)) {
      expect(g.label).toBeTruthy();
      expect(g.hint).toBeTruthy();
      expect(['filing', 'press']).toContain(g.tier);
      expect(g.domains.length).toBeGreaterThan(10);
    }
    // USPTO belongs to IP, not to the general government group
    expect(SOURCE_GROUPS.government.domains).not.toContain('uspto.gov');
    expect(SOURCE_GROUPS.ip.domains).toContain('uspto.gov');
  });

  test('groupQueries chunks the domains into OR-ed site: queries', () => {
    const qs = groupQueries('government', 'Stripe');
    expect(qs.length).toBe(Math.ceil(SOURCE_GROUPS.government.domains.length / 8));
    expect(qs[0]).toMatch(/^Stripe \(site:sec\.gov OR site:federalreserve\.gov/);
    expect(groupQueries('nope', 'x')).toEqual([]);
  });

  test('hostInGroup accepts the domain and its subdomains only', () => {
    expect(hostInGroup('https://www.sec.gov/Archives/edgar/data/1', 'government')).toBe(true);
    expect(hostInGroup('https://fred.stlouisfed.org/series/GDP', 'government')).toBe(true);
    expect(hostInGroup('https://patents.google.com/patent/US1', 'ip')).toBe(true);
    expect(hostInGroup('https://www.darpa.mil/news', 'ip')).toBe(true);
    expect(hostInGroup('https://www.mckinsey.com/insights/x', 'institutions')).toBe(true);
    expect(hostInGroup('https://notsec.gov.example.com/', 'government')).toBe(false);
    expect(hostInGroup('https://techcrunch.com/', 'institutions')).toBe(false);
    expect(groupOfUrl('https://www.brookings.edu/research/x')).toBe('institutions');
    expect(groupOfUrl('https://example.com')).toBeNull();
  });

  test('tiers: government and IP hits are filings, institutional hits are press', () => {
    expect(sourceTier({ url: 'https://www.cms.gov/newsroom/x', source: 'government' })).toBe('filing');
    expect(sourceTier({ url: 'https://fred.stlouisfed.org/series/GDP', source: 'web' })).toBe('filing');
    expect(sourceTier({ url: 'https://patents.google.com/patent/US1', source: 'web' })).toBe('filing');
    expect(sourceTier({ url: 'https://www.darpa.mil/news', source: 'ip' })).toBe('filing');
    expect(sourceTier({ url: 'https://www.mckinsey.com/insights/x', source: 'institutions' })).toBe('press');
    expect(sourceTier({ url: 'https://www.rand.org/pubs/x', source: 'web' })).toBe('press');
    expect(isVerifiedSource({ url: 'https://www.fdic.gov/news/x', source: 'government' })).toBe(true);
    expect(sourceTier({ source: 'curated', url: 'https://www.sec.gov/news/x', sourceCategory: 'government' })).toBe('filing');
    expect(sourceTier({ source: 'curated', url: 'https://example.org/x', sourceCategory: 'institutions_research' })).toBe('press');
    expect(sourceTier({ source: 'curated', url: 'https://example.org/x', sourceCategory: 'ip_research' })).toBe('filing');
  });

  test('normalizeSources accepts the group ids and their labels', () => {
    expect(normalizeSources(['Government', 'IP', 'Institutions'])).toEqual(['government', 'ip', 'institutions']);
    expect(normalizeSources(['Government & regulators', 'Patents & IP', 'Think tanks'])).toEqual(['government', 'ip', 'institutions']);
  });

  test('the curated registry carries official and institutional feeds', () => {
    const registry = require('../../../sources/registry.json');
    const cats = new Set(registry.map((r) => r.category));
    expect(cats.has('government')).toBe(true);
    expect(cats.has('ip_research')).toBe(true);
    expect(cats.has('institutions_research')).toBe(true);
    const ids = registry.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(registry.find((r) => r.id === 'G-SEC-PRESS').method.url).toMatch(/^https:\/\/www\.sec\.gov\//);
  });
});
