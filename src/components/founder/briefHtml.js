/**
 * The written briefs (quick and deep) as safe HTML.
 *
 * A brief is written from record titles and quotes, which come from outside
 * pages: a page can put a markdown link ("full dossier here") or an image
 * that loads from its own server each time the report is opened. So the
 * only links a brief may keep are its own citations to records on this page;
 * every other link becomes plain text, and every image, embedded media,
 * form and inline style is removed, on top of the usual sanitising.
 *
 * Markdown is always read (with any HTML in it), so a citation is a link even
 * when the text also carries HTML.
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const FORBID_TAGS = ['img', 'picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'input', 'button', 'textarea', 'select', 'style', 'link', 'meta', 'base'];
const FORBID_ATTR = ['style', 'srcset', 'background', 'poster', 'formaction', 'target'];

const escape = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @param {string} text the brief, with "[Source n]" citations
 * @param {{ anchor: string, label?: string }} opts anchor: the id prefix records carry ("deep-source", "source");
 *   label: what goes before the number in the pill ("Q" for the quick brief, so it never reads like a deep record)
 * @returns {string} HTML
 */
export function briefHtml(text, { anchor, label = '' } = {}) {
  const md = String(text || '')
    .replace(/\\n/g, '\n') // some model paths send literal "\n"
    // markdown images, before anything else reads them as links
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[Source (\d+)\]/g, (m, n) => `[[${label}${n}]](#${anchor}-${n})`);
  // on the server (first render) the text is shown escaped; the browser renders it properly
  if (typeof window === 'undefined' || typeof document === 'undefined') return escape(md);
  const html = marked.parse(md, { breaks: true, gfm: true });
  const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS, FORBID_ATTR });
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  const own = new RegExp(`^#${anchor}-\\d+$`);
  tpl.content.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (own.test(href)) {
      a.removeAttribute('rel');
      a.setAttribute('class', 'cite');
      return;
    }
    a.replaceWith(document.createTextNode(a.textContent || ''));
  });
  return tpl.innerHTML;
}
