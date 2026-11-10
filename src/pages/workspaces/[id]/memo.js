/**
 * /workspaces/:id/memo — print-optimized investment memo for a workspace.
 * "Save as PDF" uses the browser's print dialog; ?print=1 opens it on load.
 */
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from 'next-auth/react';
import { HiOutlineArrowLeft, HiOutlineDocumentArrowDown, HiOutlinePrinter } from 'react-icons/hi2';
import PageShell, { SignInPrompt } from '../../../components/layout/PageShell';

const ICON = { width: 15, height: 15 };

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
    if (b.type === 'subheading') out.push(<h3 key={i} className="mt-4 mb-2 text-sm font-semibold text-ink">{b.text}</h3>);
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
      <a href={`${api}?format=docx`} download className="btn-primary px-3 py-2 text-xs"><HiOutlineDocumentArrowDown style={ICON} /> Download Word</a>
      <a href={`${api}?format=md`} download className="btn-secondary px-3 py-2 text-xs">Download Markdown</a>
      <button type="button" onClick={() => window.print()} disabled={!memo} className="btn-secondary px-3 py-2 text-xs"><HiOutlinePrinter style={ICON} /> Save as PDF</button>
    </div>
  );

  if (status === 'loading') return <PageShell title="Investment memo"><p className="muted">Loading…</p></PageShell>;
  if (status !== 'authenticated') return <PageShell title="Investment memo"><SignInPrompt what="memo export" /></PageShell>;

  return (
    <PageShell title="Investment memo" subtitle={memo ? memo.company : undefined} actions={memo ? actions : null}>
      <div className="no-print mb-3">
        {id && <Link href={`/workspaces/${encodeURIComponent(id)}`} className="btn-ghost -ml-2.5"><HiOutlineArrowLeft style={ICON} /> Back to workspace</Link>}
      </div>
      {error && <div className="no-print rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">{error}</div>}
      {!error && !memo && (
        <div className="card px-8 py-10" aria-busy="true" aria-live="polite">
          <p className="muted">Assembling memo from the workspace&apos;s searches, notes, sources and documents…</p>
          <div className="mt-6 space-y-2.5">
            <div className="skeleton h-7 w-1/2" />
            <div className="skeleton h-3 w-1/4" />
            <div className="mt-6 skeleton h-4 w-1/3" />
            <div className="skeleton h-3 w-full" />
            <div className="skeleton h-3 w-11/12" />
            <div className="skeleton h-3 w-4/5" />
          </div>
        </div>
      )}
      {memo && (
        <article className="memo-print card px-6 py-8 text-ink sm:px-10 sm:py-12">
          <header className="memo-title-page mb-8 border-b border-line pb-6">
            <p className="eyebrow mb-2">Investment memo</p>
            <h1 className="mb-4 text-3xl font-semibold tracking-tight">{memo.company}</h1>
            <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm text-slate-700">
              <dt className="font-medium">Workspace</dt><dd>{memo.workspaceName}</dd>
              <dt className="font-medium">Generated</dt><dd>{fmt(memo.generatedAt)}</dd>
            </dl>
            <p className="mt-4 text-xs italic text-muted">{memo.preparedWith || 'Prepared with Research Hub'}</p>
          </header>

          {memo.sections.length === 0 && memo.sources.length === 0 && (
            <p className="muted">This workspace has no searches, notes, saved sources or documents yet, so there is nothing to put in the memo.</p>
          )}

          {memo.sections.map((s) => (
            <section key={s.heading} className="memo-section mb-6">
              <h2 className="mb-3 border-b border-line pb-1 text-lg font-semibold text-ink">{s.heading}</h2>
              <div className="text-sm text-slate-700"><Blocks blocks={s.blocks} /></div>
            </section>
          ))}

          {memo.sources.length > 0 && (
            <section className="memo-section memo-sources">
              <h2 className="mb-3 border-b border-line pb-1 text-lg font-semibold text-ink">Sources</h2>
              <ol className="list-none space-y-2 pl-0 text-xs">
                {memo.sources.map((src) => (
                  <li key={src.n} id={`src-${src.n}`} className="flex gap-2">
                    <span className="w-6 shrink-0 font-semibold">[{src.n}]</span>
                    <span>
                      {src.url ? <a href={src.url} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 hover:underline">{src.title}</a> : src.title}
                      <span className="text-slate-600"> ({[src.sourceName, src.date || 'undated'].filter(Boolean).join(', ')})</span>
                      {src.url && <span className="memo-url block break-all text-muted">{src.url}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </article>
      )}

      <style jsx global>{`
        .memo-cite { font-size: 0.7em; margin-left: 1px; }
        .memo-cite a { color: rgb(var(--c-brand-600)); text-decoration: none; }
        @media print {
          @page { margin: 18mm 16mm; }
          html, body { background: #fff !important; background-image: none !important; }
          header.glass, nav, footer, .no-print { display: none !important; }
          /* hide everything PageShell renders except the memo itself */
          main > *:not(:has(.memo-print)) { display: none !important; }
          main { padding: 0 !important; max-width: none !important; margin: 0 !important; }
          main > div { max-width: none !important; }
          .memo-print { border: none !important; box-shadow: none !important; padding: 0 !important; border-radius: 0 !important; font-size: 11pt; }
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
