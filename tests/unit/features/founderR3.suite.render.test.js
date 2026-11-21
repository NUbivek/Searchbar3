/** @jest-environment jsdom */
/**
 * Final pass (suite): the shared answer renderer (Open Research answers) keeps no image and no outside link.
 * Model text is written from outside pages, which can carry a link or an image that calls home each time the
 * answer is opened; citations are added after sanitising, so only in-page anchors are kept.
 */
import { renderSafeHtml } from '../../../src/components/search/results/SimplifiedLLMResults';

const tpl = (html) => { const t = document.createElement('template'); t.innerHTML = html; return t.content; };

test('images and embedded media are removed', () => {
  const out = tpl(renderSafeHtml('Revenue grew ![x](https://evil.test/p.png) <img src="https://evil.test/q.png"> <picture><source srcset="https://evil.test/r.png"></picture>'));
  expect(out.querySelector('img, picture, source')).toBeNull();
  expect(out.textContent).toMatch(/Revenue grew/);
});

test('outside links become plain text; in-page anchors stay', () => {
  const md = tpl(renderSafeHtml('See [the file](https://evil.test/x) and [source](#source-2).'));
  expect([...md.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['#source-2']);
  expect(md.textContent).toMatch(/See the file and source\./);
  const html = tpl(renderSafeHtml('<p>See <a href="https://evil.test/x">the file</a> and <a href="javascript:alert(1)">this</a> and <a href="#source-3">source</a>.</p>'));
  expect([...html.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['#source-3']);
  expect(html.textContent).toMatch(/See the file and this and source\./);
});
