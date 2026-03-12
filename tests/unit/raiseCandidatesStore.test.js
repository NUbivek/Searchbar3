const { __test } = require('../../src/lib/raiseCandidatesStore');

describe('raiseCandidatesStore classification hygiene', () => {
  test('normalizes recoverable directory labels using evidence title', () => {
    expect(__test.normalizeDirectorySignalName('VisitCaladan', 'Caladan')).toBe('Caladan');
    expect(__test.normalizeDirectorySignalName('Meet Hatch', 'Hatch')).toBe('Hatch');
  });

  test('maps bare region codes to country names', () => {
    expect(__test.inferCountryFromText('US')).toBe('United States');
    expect(__test.inferCountryFromText('IL')).toBe('Israel');
  });

  test('falls back to United States for US startup inventory sources', () => {
    expect(__test.inferCountry({
      hq: '',
      description: '',
      startupName: 'ExampleCo',
      startupUrl: '',
      sourceUrl: 'https://cleanenergyventures.com/portfolio',
      sourceRegion: 'US',
      sourceCategory: 'venture_portfolio',
    })).toBe('United States');
  });

  test('uses source-grounded fallback summaries instead of generic AI text', () => {
    expect(
      __test.summarizeDescription(
        'MOL Switch',
        'MOL Switch',
        'energy|industrial_decarbonization|supply_chain',
        'Clean Energy Ventures',
        'directory_listing',
        'venture_portfolio'
      )
    ).toBe('Listed in Clean Energy Ventures portfolio. Sector tags: energy, industrial decarbonization, supply chain.');
  });

  test('blocks directory rows that point to investor/program hosts', () => {
    const result = __test.classifyCandidateRow({
      startup_name: 'SOSV',
      startup_url: 'https://sosv.com/',
      source_url: 'https://cleanenergyventures.com/portfolio',
      signal_type: 'directory_listing',
      has_distinct_company_website: false,
    });

    expect(result.type).toBe('noise');
    expect(result.reasons).toContain('directory_investor_or_program_host');
  });

  test('blocks directory rows whose name does not match the destination host', () => {
    const result = __test.classifyCandidateRow({
      startup_name: 'PartTec',
      startup_url: 'https://www.ge.com/',
      source_url: 'https://elevateventures.com/portfolio',
      signal_type: 'directory_listing',
      has_distinct_company_website: false,
    });

    expect(result.type).toBe('noise');
    expect(result.reasons).toContain('directory_name_url_mismatch');
  });
});
