const { tieOf } = require('../../../src/server/founder/deepCheck');
test.each([
  ['CEO', 'affiliate'],
  ['founder (past)', 'affiliate'],
  ['the company given', 'primary'],
  ['French company where a Arthur Mensch is president', 'primary'],
  ['Form D names the person as Executive Officer and Director', 'primary'],
  ['founder; chief executive officer (Wikidata)', 'primary'],
  ['UK director appointment (Companies House)', 'affiliate'],
  ['board member (Wikidata)', 'affiliate'],
  ['ran it; named in a record about the person (Sample news)', 'primary'],
])('a company thread whose reason is "%s" is %s', (why, tie) => {
  expect(tieOf({ kind: 'company', value: 'X', why })).toBe(tie);
});
