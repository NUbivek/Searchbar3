const { cleanSentences, cleanModelText } = require('../../../src/server/founder/guardrails');
test('perf', () => {
  const inputs = [
    '1 2 3 4 5 6 7 8 9 '.repeat(250),
    'Aaa Bbb Ccc Ddd '.repeat(300) + 'born',
    '(' .repeat(500) + 'born 1984',
    'his ' .repeat(800),
    '[a](' + '('.repeat(300),
    'call ' + '1-'.repeat(1500) + '…',
    'donated ' + 'x '.repeat(1000),
    'Born ' + 'Aa. '.repeat(800),
  ];
  for (const s of inputs) {
    const t = Date.now();
    cleanSentences(s); cleanModelText(s);
    const ms = Date.now() - t;
    console.log(s.slice(0, 15), ms);
    expect(ms).toBeLessThan(1500);
  }
});
