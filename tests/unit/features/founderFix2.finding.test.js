const { severityFromText } = require('../../../src/server/founder/finding');

describe('severityFromText: money outcomes and ousters are medium', () => {
  test.each([
    'An arbitration panel ordered him to pay the company $165 million',
    'The founder was ordered to pay $168 million in an arbitration award',
    'The company won an arbitration against its former chief executive',
    'The board moved to claw back his stock awards',
    'A clawback of $165 million was approved by the court',
    'The court entered a judgment against the former chairman',
    'A jury returned a damages award of $2 million',
    'He agreed to pay restitution to investors',
    'The co-founder was forced out by the board in 2019',
    'The chief executive stepped down amid investor pressure',
    'She steps down under pressure from shareholders',
  ])('%s', (text) => {
    expect(severityFromText(text)).toBe('medium');
  });
});

describe('severityFromText: a probe that was declined, closed or cleared is info', () => {
  test.each([
    'The UK competition regulator decided not to investigate the partnership',
    'The CMA closes its inquiry into the minority investment',
    'Regulator clears the investment after a short probe',
    'The watchdog will not open a formal investigation into the deal',
    'The agency dropped its investigation into the startup',
  ])('%s', (text) => {
    expect(severityFromText(text)).toBe('info');
  });

  test('a probe still open, or an outcome in the same clause, keeps its weight', () => {
    expect(severityFromText('Regulators open an investigation into the deal')).toBe('medium');
    expect(severityFromText('The company declined to comment on the investigation')).toBe('medium');
    expect(severityFromText('Shares dropped 5% on an SEC investigation')).toBe('medium');
    expect(severityFromText('The store closed amid an investigation')).toBe('medium');
    expect(severityFromText('The SEC closed its investigation after the company agreed to a $10 million settlement')).toBe('medium');
    expect(severityFromText('Prosecutors declined to investigate the insider trading claims')).toBe('high');
    expect(severityFromText('The agency closed its probe. Months later he was indicted for wire fraud.')).toBe('high');
    expect(severityFromText('The agency closed its probe. A separate lawsuit is pending.')).toBe('medium');
  });

  test('the same clause still lowers when it opens a new probe elsewhere in the text', () => {
    expect(severityFromText('The CMA closes its inquiry into the deal. The SEC opened a new investigation.')).toBe('medium');
  });
});

describe('severityFromText: a lawsuit over a publication called defamatory is low', () => {
  test('a disputed article is not a red flag', () => {
    expect(severityFromText('He sued the newspaper over an article alleging misconduct at the firm, which he said was defamatory')).toBe('medium');
    expect(severityFromText('He sued the magazine over an article, which he said was defamatory')).toBe('low');
    expect(severityFromText('The founder filed a lawsuit over an opinion piece he called false and defamatory')).toBe('low');
  });

  test('a real outcome or a criminal matter in the same record keeps its weight', () => {
    expect(severityFromText('He sued over a story he called defamatory and was ordered to pay legal fees')).toBe('medium');
    expect(severityFromText('He was convicted of fraud and called the report defamatory')).toBe('high');
    expect(severityFromText('Investors sued him for fraud; the company called the claims baseless')).toBe('medium');
  });
});

describe('severityFromText: earlier behaviour unchanged', () => {
  test('existing levels', () => {
    expect(severityFromText('Company sued by landlord')).toBe('medium');
    expect(severityFromText('She stepped down as CEO')).toBe('low');
    expect(severityFromText('Founder speaks at a conference')).toBe('info');
    expect(severityFromText('Grand jury indicts founder')).toBe('high');
  });
});
