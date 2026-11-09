/**
 * Tavus guide agent: tool calls map to the right route (or a clear error),
 * and the page description tells the agent where the visitor is.
 */
const { planToolCall, describePage, initialContext, SECTIONS } = require('../../../src/components/tavus/guideTools');

describe('planToolCall', () => {
  test('go_to_section opens each main section', () => {
    expect(planToolCall('go_to_section', '{"section":"open_research"}')).toMatchObject({ href: { pathname: '/' } });
    expect(planToolCall('go_to_section', '{"section":"network_map"}')).toMatchObject({ href: { pathname: '/network' }, say: 'Opened Network Map.' });
    expect(planToolCall('go_to_section', '{"section":"founder_check"}')).toMatchObject({ href: { pathname: '/founder' } });
    expect(Object.keys(SECTIONS)).toEqual(['open_research', 'network_map', 'founder_check']);
    expect(planToolCall('go_to_section', '{"section":"pricing"}').error).toMatch(/Unknown section/);
  });

  test('run_research opens Open Research with the query', () => {
    expect(planToolCall('run_research', '{"query":"  Stripe funding  "}')).toMatchObject({ href: { pathname: '/', query: { q: 'Stripe funding' } } });
    expect(planToolCall('run_research', '{"query":""}').error).toMatch(/required/);
  });

  test('run_founder_check needs a full name; company is optional', () => {
    expect(planToolCall('run_founder_check', '{"name":"Arthur Mensch","company":"Mistral"}'))
      .toMatchObject({ href: { pathname: '/founder', query: { name: 'Arthur Mensch', company: 'Mistral' } } });
    expect(planToolCall('run_founder_check', '{"name":"Arthur Mensch"}').href.query).toEqual({ name: 'Arthur Mensch' });
    expect(planToolCall('run_founder_check', '{"name":"Arthur"}').error).toMatch(/first and last/);
  });

  test('bad JSON and unknown tools are errors, never throws', () => {
    expect(planToolCall('run_research', '{not json').error).toMatch(/not valid JSON/);
    expect(planToolCall('book_meeting', '{}').error).toMatch(/Unknown tool/);
    expect(planToolCall('go_to_section', undefined).error).toMatch(/Unknown section/);
  });
});

describe('describePage / initialContext', () => {
  test('names the page and the current query', () => {
    expect(describePage('/', { q: 'Anthropic funding' })).toBe('The visitor is on Open Research (research a company, founder or market). Their current research query is "Anthropic funding".');
    expect(describePage('/founder', { name: 'Arthur Mensch', company: 'Mistral' })).toMatch(/checking the founder "Arthur Mensch" at Mistral/);
    expect(describePage('/network', {})).toMatch(/Network Map/);
    expect(describePage('/company/[name]', { name: 'Stripe' })).toMatch(/company profile.*"Stripe"/);
    expect(describePage('/unknown', {})).toBe('The visitor is on /unknown.');
  });
  test('initial context describes the site, the tools and the current page', () => {
    const ctx = initialContext('/', { q: 'Ramp' });
    expect(ctx).toMatch(/Research Hub/);
    expect(ctx).toMatch(/Use the tools/);
    expect(ctx).toMatch(/"Ramp"/);
  });
});
