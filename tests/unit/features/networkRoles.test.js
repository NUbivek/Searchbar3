/**
 * Network Map roles: a contact's title/company places them in a role and in
 * the raise / source / diligence lenses, deterministically.
 */
const { classifyContact, inLens, roleStats, lensFromQuestion, LENS_KEYS } = require('../../../src/utils/network/roles');

const c = (name, position, company, tags) => ({ name, position, company, tags });

describe('classifyContact', () => {
  test('LPs and allocators are raise only', () => {
    expect(classifyContact(c('A', 'Managing Director', 'Smith Family Office'))).toMatchObject({ role: 'lp', group: 'investors', lenses: ['raise'] });
    expect(classifyContact(c('B', 'Chief Investment Officer', 'Yale Endowment')).role).toBe('lp');
    expect(classifyContact(c('C', 'Limited Partner', 'Acme')).role).toBe('lp');
  });

  test('VCs and angels are raise + source; a generic partner title needs a fund-like employer', () => {
    expect(classifyContact(c('A', 'Partner', 'Sequoia Capital'))).toMatchObject({ role: 'investor', lenses: ['raise', 'source'] });
    expect(classifyContact(c('B', 'Angel investor', ''))).toMatchObject({ role: 'investor' });
    expect(classifyContact(c('C', 'Associate', 'Gunderson Dettmer LLP')).role).toBe('lawyer');
    expect(classifyContact(c('D', 'Partner', 'McKinsey & Company')).role).toBe('consultant');
  });

  test('founders and executives source and diligence; operators diligence', () => {
    expect(classifyContact(c('A', 'Co-Founder & CEO', 'Stealth'))).toMatchObject({ role: 'founder', group: 'founders', lenses: ['source', 'diligence'] });
    expect(classifyContact(c('B', 'VP Engineering', 'Stripe')).role).toBe('executive');
    expect(classifyContact(c('C', 'Software Engineer', 'Google'))).toMatchObject({ role: 'operator', lenses: ['diligence', 'source'] });
  });

  test('experts: bankers, lawyers, accountants, consultants, academics, press', () => {
    expect(classifyContact(c('A', 'Vice President, Investment Banking', 'Goldman Sachs')).role).toBe('banker');
    expect(classifyContact(c('B', 'Corporate Counsel', 'Cooley LLP')).role).toBe('lawyer');
    expect(classifyContact(c('C', 'Audit Senior', 'KPMG')).role).toBe('accountant');
    expect(classifyContact(c('D', 'Professor of Computer Science', 'UC Berkeley')).role).toBe('academic');
    expect(classifyContact(c('E', 'Reporter', 'TechCrunch')).role).toBe('press');
    for (const r of ['banker', 'lawyer', 'accountant', 'academic', 'press']) {
      // every expert role is in the diligence lens
      expect(inLens(c('X', 'x', 'x'), r)).toBe(false);
    }
    expect(inLens(c('D', 'Professor', 'MIT'), 'diligence')).toBe(true);
  });

  test('tags count as title text; no title and no company is "other"', () => {
    expect(classifyContact(c('A', '', 'Acme', ['angel investor'])).role).toBe('investor');
    expect(classifyContact(c('B', '', ''))).toMatchObject({ role: 'other', group: 'other', lenses: [] });
  });

  test('roleStats counts roles, groups and lenses', () => {
    const stats = roleStats([
      c('A', 'Partner', 'Sequoia Capital'), c('B', 'Founder', 'Acme'), c('C', 'Reporter', 'Forbes'), c('D', '', ''),
    ]);
    expect(stats.groups).toEqual({ investors: 1, founders: 1, experts: 1, other: 1 });
    expect(stats.lenses).toEqual({ raise: 1, source: 3, diligence: 2 });
    expect(stats.roles.investor).toBe(1);
  });
});

describe('lensFromQuestion', () => {
  test('recognises raise, source and diligence phrasing', () => {
    expect(lensFromQuestion('Who can help me raise our next fund?')).toBe('raise');
    expect(lensFromQuestion('which LPs do I know')).toBe('raise');
    expect(lensFromQuestion('who sends me deal flow in fintech')).toBe('source');
    expect(lensFromQuestion('Who can diligence an AI infrastructure company?')).toBe('diligence');
    expect(lensFromQuestion('who can do reference checks on this founder')).toBe('diligence');
    expect(lensFromQuestion('Who do I know at Stripe?')).toBeNull();
  });
  test('lens keys are stable', () => {
    expect(LENS_KEYS).toEqual(['raise', 'source', 'diligence']);
  });
});
