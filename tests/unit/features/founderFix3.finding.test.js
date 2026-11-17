const { makeFinding, severityFromText } = require('../../../src/server/founder/finding');
const { createSubject, addAnchor } = require('../../../src/server/founder/identity');

describe('makeFinding: title and quote are graded as separate sentences', () => {
  const subject = createSubject({ name: 'Jordan Vale' });
  addAnchor(subject, 'companies', 'Kestrel Motors', 'given');
  const f = makeFinding(subject, {
    source: 'web',
    sourceLabel: 'Web',
    category: 'press',
    title: 'Jordan Vale - Wikipedia',
    quote: 'Kestrel Motors founder Jordan Vale stepped down in 2020.',
    url: 'https://en.wikipedia.org/wiki/Jordan_Vale',
  });

  test('the quote\'s first word is not glued to the title, so the company anchor counts', () => {
    expect(f).not.toBeNull();
    expect(['confirmed', 'likely']).toContain(f.match);
  });

  test('the stored grade text keeps the line break for a later re-grade', () => {
    expect(f.gradeText).toBe('Jordan Vale - Wikipedia\nKestrel Motors founder Jordan Vale stepped down in 2020.');
  });
});

describe('severityFromText: a criminal matter told about another named person', () => {
  const subject = createSubject({ name: 'Jordan Vale' });
  const disputed = 'In 2023, Vale sued a magazine over an article claiming Vale misled investors and comparing him to Casey Rowe, the biotech founder who was convicted of wire fraud, which Vale called defamatory.';

  test('the aside about the other person does not make the subject\'s record high', () => {
    expect(severityFromText('Vale was compared to Casey Rowe, who was convicted of wire fraud.', subject)).not.toBe('high');
    expect(severityFromText(disputed, subject)).toBe('low');
  });

  test('without the subject, or when the aside is about the subject, the weight stays', () => {
    expect(severityFromText('Vale was compared to Casey Rowe, who was convicted of wire fraud.')).toBe('high');
    expect(severityFromText('Jordan Vale, who was convicted of wire fraud, founded the firm.', subject)).toBe('high');
    expect(severityFromText('Casey Rowe, who accused him of fraud, testified.', subject)).toBe('medium');
    expect(severityFromText('Casey Rowe, who was convicted of fraud alongside him, testified.', subject)).toBe('high');
    expect(severityFromText('Vale was charged with wire fraud. Casey Rowe, who was convicted, testified.', subject)).toBe('high');
  });
});

describe('severityFromText: a disputed claim of a crime is low', () => {
  test('a criminal claim inside an article called defamatory is low, with a wide gap', () => {
    expect(severityFromText('He sued over an article claiming he was indicted for securities fraud, which he called defamatory')).toBe('low');
    expect(severityFromText('He sued the paper over a long and widely shared magazine article published in the spring, which claimed in detail that he had been charged with wire fraud by prosecutors, and which he called defamatory')).toBe('low');
  });

  test('a criminal matter outside the claim, or not claimed by it, stays high', () => {
    expect(severityFromText('He was convicted of fraud and called the report defamatory')).toBe('high');
    expect(severityFromText('In a statement, he was charged with wire fraud, and his lawyer called the article defamatory')).toBe('high');
    expect(severityFromText('He was indicted in 2020. He sued over an article about it, calling it defamatory')).toBe('high');
    expect(severityFromText('He sued over an article claiming he was indicted, calling it defamatory, and was fined $1 million')).toBe('high');
  });
});
