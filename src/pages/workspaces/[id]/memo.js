/**
 * /workspaces/:id/memo — print-optimized investment memo for a workspace.
 * "Save as PDF" uses the browser's print dialog; ?print=1 opens it on load.
 */
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from 'next-auth/react';
import PageShell, { SignInPrompt } from '../../../components/layout/PageShell';

/** Render **bold** and [n] citation markers (linked to the Sources list). */
function Inline({ text }) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|\[\d+(?:,\s*\d+)*\])/g).filter(Boolean);
  return parts.map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={i}>{p.slice(2, -2)}</strong>;
    const cite = p.match(/^\[(\d+(?:,\s*\d+)*)\]$/);
    if (cite) {
      const nums = cite[1].split(/,\s*/);
      return (
        <sup key={i} className="memo-cite">
          [{nums.map((n, j) => <React.Fragment key={n}>{j > 0 && ', '}<a href={`#src-${n}`}>{n}</a></React.Fragment>)}]
        </sup>
      );
    }
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
}

function Blocks({ blocks }) {
  const out = [];
  let list = [];
  const flush = (key) => {
    if (list.length) out.push(<ul key={`ul-${key}`} className="list-disc pl-6 space-y-1 mb-3">{list}</ul>);
    list = [];
  };
  blocks.forEach((b, i) => {
    if (b.type === 'bullet') {
      list.push(<li key={i} className="whitespace-pre-line"><Inline text={b.text} /></li>);
      return;
    }
    flush(i);
    if (b.type === 'subheading') out.push(<h3 key={i} className="text-sm font-semibold text-gray-700 mt-4 mb-2">{b.text}</h3>);
    else out.push(<p key={i} className="mb-3 leading-relaxed"><Inline text={b.text} /></p>);
  });
  flush('end');
  return out;
}

const fmt = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
};

export default function WorkspaceMemoPage() {
  const router = useRouter();
  const { id, print } = router.query;
  const { status } = useSession();
  const [memo, setMemo] = useState(null);
  const [error, setError] = useState(null);
  const printed = useRef(false);

  useEffect(() => {
    if (status !== 'authenticated' || !id) return;
    let cancelled = false;
    setError(null);
    fetch(`/api/workspaces/${encodeURIComponent(id)}/memo?format=json`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
        return body.memo;
      })
      .then((m) => { if (!cancelled) setMemo(m); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [status, id]);

  useEffect(() => {
    if (memo && print === '1' && !printed.current) {
      printed.current = true;
      setTimeout(() => window.print(), 300);
    }
  }, [memo, print]);

  const api = id ? `/api/workspaces/${encodeURIComponent(id)}/memo` : '#';
  const actions = (
    <div className="no-print flex flex-wrap gap-2">
      <a href={`${api}?format=docx`} download className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium">Download Word</a>
      <a href={`${api}?format=md`} download className="bg-white border border-gray-300 hover:border-blue-400 text-gray-700 px-3 py-1.5 rounded-md text-sm font-medium">Download Markdown</a>
      <button type="button" onClick={() => window.print()} disabled={!memo} className="bg-white border border-gray-300 hover:border-blue-400 text-gray-700 px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50">Save as PDF</button>
    </div>
  );

  if (status === 'loading') return <PageShell title="Investment memo"><p className="text-gray-500 text-sm">Loading…</p></PageShell>;
  if (status !== 'authenticated') return <PageShell title="Investment memo"><SignInPrompt what="memo export" /></PageShell>;

  return (
    <PageShell title="Investment memo" subtitle={memo ? memo.company : undefined} actions={memo ? actions : null}>
      <div className="no-print mb-3">
        {id && <Link href={`/workspaces/${encodeURIComponent(id)}`} className="text-sm text-blue-600 hover:text-blue-800">← Back to workspace</Link>}
      </div>
      {error && <div className="no-print bg-red-50 border border-red-200 text-red-700 rounded-md p-3 text-sm">{error}</div>}
      {!error && !memo && <p className="text-gray-500 text-sm">Assembling memo…</p>}
      {memo && (
        <article className="memo-print bg-white border border-gray-200 rounded-lg px-8 py-10 text-gray-900">
          <header className="memo-title-page mb-8 pb-6 border-b border-gray-200">
            <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">Investment memo</p>
            <h1 className="text-3xl font-bold mb-4">{memo.company}</h1>
            <dl className="text-sm text-gray-700 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1">
              <dt className="font-medium">Workspace</dt><dd>{memo.workspaceName}</dd>
              <dt className="font-medium">Generated</dt><dd>{fmt(memo.generatedAt)}</dd>
            </dl>
            <p className="text-xs text-gray-500 mt-4 italic">{memo.preparedWith || 'Prepared with Research Hub'}</p>
          </header>

          {memo.sections.length === 0 && memo.sources.length === 0 && (
            <p className="text-gray-600 text-sm">This workspace has no searches, notes, saved sources or documents yet, so there is nothing to put in the memo.</p>
          )}

          {memo.sections.map((s) => (
            <section key={s.heading} className="memo-section mb-6">
              <h2 className="text-lg font-semibold text-gray-900 border-b border-gray-100 pb-1 mb-3">{s.heading}</h2>
              <div className="text-sm"><Blocks blocks={s.blocks} /></div>
            </section>
          ))}

          {memo.sources.length > 0 && (
            <section className="memo-section memo-sources">
              <h2 className="text-lg font-semibold text-gray-900 border-b border-gray-100 pb-1 mb-3">Sources</h2>
              <ol className="text-xs space-y-2 list-none pl-0">
                {memo.sources.map((src) => (
                  <li key={src.n} id={`src-${src.n}`} className="flex gap-2">
                    <span className="font-semibold w-6 shrink-0">[{src.n}]</span>
                    <span>
                      {src.url ? <a href={src.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">{src.title}</a> : src.title}
                      <span className="text-gray-600"> ({[src.sourceName, src.date || 'undated'].filter(Boolean).join(', ')})</span>
                      {src.url && <span className="block text-gray-500 break-all memo-url">{src.url}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </article>
      )}

      <style jsx global>{`
        .memo-print {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
        }
        .memo-cite { font-size: 0.7em; margin-left: 1px; }
        .memo-cite a { color: #1d4ed8; text-decoration: none; }
        @media print {
          @page { margin: 18mm 16mm; }
          html, body, .bg-gray-50 { background: #fff !important; }
          nav, .no-print { display: none !important; }
          /* hide everything PageShell renders except the memo itself */
          main > *:not(:has(.memo-print)) { display: none !important; }
          main { padding: 0 !important; max-width: none !important; margin: 0 !important; }
          main > div { max-width: none !important; }
          .memo-print { border: none !important; padding: 0 !important; border-radius: 0 !important; font-size: 11pt; }
          .memo-print .text-sm { font-size: 10.5pt; }
          .memo-print .text-xs { font-size: 9pt; }
          .memo-title-page { break-after: page; page-break-after: always; border: none !important; padding-top: 30vh; }
          .memo-title-page h1 { font-size: 28pt; }
          h2, h3 { break-after: avoid; page-break-after: avoid; }
          li, p { break-inside: avoid; page-break-inside: avoid; orphans: 3; widows: 3; }
          .memo-sources { break-before: page; page-break-before: always; }
          .memo-print a { color: #000 !important; text-decoration: none; }
          .memo-cite a { color: #000 !important; }
        }
      `}</style>
    </PageShell>
  );
}
