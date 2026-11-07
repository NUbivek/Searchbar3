import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import PageShell from '../components/layout/PageShell';
import { renderSafeHtml } from '../components/search/results/SimplifiedLLMResults';
import { skippedNote } from '../utils/skippedNote';

const EMPTY = 'Nothing found in available sources.';

function Cite({ index, sources }) {
  const s = sources[index];
  if (!s) return null;
  return (
    <a href={`#source-${s.n}`} className="text-blue-600 hover:underline text-xs ml-1 whitespace-nowrap" title={s.title}>
      [{s.n}] {s.sourceName}{s.date ? `, ${s.date}` : ''}
    </a>
  );
}

function Flag({ item }) {
  if (!item.possibleDifferentPerson) return null;
  return (
    <span className="ml-2 inline-block text-xs bg-yellow-100 text-yellow-800 border border-yellow-200 rounded px-1.5 py-0.5">
      possible different person
    </span>
  );
}

function Quote({ item, sources }) {
  return (
    <p className="text-sm text-gray-800">
      <span>&ldquo;{item.quote}&rdquo;</span>
      {item.headline && <span className="text-xs text-gray-500 ml-1">(headline)</span>}
      <Cite index={item.sourceIndex} sources={sources} />
      <Flag item={item} />
    </p>
  );
}

function Section({ title, children, empty, note }) {
  return (
    <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <h2 className="text-lg font-semibold text-gray-800 mb-2">{title}</h2>
      {note}
      {empty ? <p className="text-sm text-gray-500 italic">{EMPTY}</p> : children}
    </section>
  );
}

export default function FounderPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const qName = typeof router.query.name === 'string' ? router.query.name : '';
  const qCompany = typeof router.query.company === 'string' ? router.query.company : '';

  useEffect(() => {
    if (!router.isReady) return;
    setName(qName);
    setCompany(qCompany);
    if (!qName.trim()) { setData(null); return; }
    let cancelled = false;
    setLoading(true);
    setError('');
    setData(null);
    const params = new URLSearchParams({ name: qName });
    if (qCompany.trim()) params.set('company', qCompany);
    fetch(`/api/founder?${params}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
        return body;
      })
      .then((body) => { if (!cancelled) setData(body); })
      .catch((e) => { if (!cancelled) setError(e.message || 'Request failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [router.isReady, qName, qCompany]);

  const onSubmit = (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setError('Enter a full name.'); return; }
    const query = { name: n };
    if (company.trim()) query.company = company.trim();
    router.push({ pathname: '/founder', query }, undefined, { shallow: true });
  };

  const sources = data?.sources || [];

  return (
    <PageShell
      title="Founder Check"
      subtitle="Background brief, career timeline, past companies, education, litigation mentions, press and backchannel references for a person, from cited sources."
    >
      <form onSubmit={onSubmit} className="bg-white border border-gray-200 rounded-lg p-4 mb-4 flex flex-col md:flex-row gap-2">
        <input
          type="text"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full name (exact spelling, e.g. Arthur Mensch)"
          className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="text"
          value={company}
          maxLength={120}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="Company (optional)"
          className="md:w-64 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          disabled={loading}
          className="bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white px-4 py-2 rounded-md text-sm"
        >
          {loading ? 'Checking...' : 'Run check'}
        </button>
      </form>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 mb-4 text-sm">{error}</div>}
      {loading && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 text-sm text-gray-600">
          Searching the web, news, public profile pages, your curated sources, Hacker News and court records for &ldquo;{qName}&rdquo;. This can take up to 30 seconds.
        </div>
      )}

      {data && (
        <>
          {data.briefInfo && (
            <p className="text-xs text-gray-500 mb-2">
              {data.briefInfo.mode === 'ai'
                ? <>Brief written by <strong>{data.briefInfo.model}</strong> ({data.briefInfo.provider}) from the cited sources{data.briefInfo.confidence ? <> · Confidence: <strong>{data.briefInfo.confidence.level}</strong>{data.briefInfo.confidence.reason ? ` (${data.briefInfo.confidence.reason})` : ''}</> : null}{skippedNote(data.briefInfo.skipped)}</>
                : <>Brief quoted directly from sources ({data.briefInfo.reason}).</>}
            </p>
          )}

          {data.brief && (
            <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
              <h2 className="text-lg font-semibold text-gray-800 mb-2">Background brief: {data.name}{data.company ? ` (${data.company})` : ''}</h2>
              <div
                className="text-sm text-gray-800 founder-brief space-y-2"
                dangerouslySetInnerHTML={{ __html: renderSafeHtml(String(data.brief).replace(/\[Source (\d+)\]/g, '[[$1]](#source-$1)')) }}
              />
            </section>
          )}

          {data.profiles?.length > 0 && (
            <Section title="Public profiles" empty={false}>
              <ul className="space-y-2">
                {data.profiles.map((p, i) => (
                  <li key={i} className="text-sm text-gray-800">
                    <span className="font-medium">{p.platform}:</span>{' '}
                    {[p.role, p.company].filter(Boolean).join(' at ') || 'Profile'}
                    {p.location ? ` · ${p.location}` : ''}
                    {p.education ? ` · Education: ${p.education}` : ''}
                    <Cite index={p.sourceIndex} sources={sources} />
                  </li>
                ))}
              </ul>
              <p className="text-xs text-gray-500 mt-2">From public profile pages as they appear in web search results; check that each profile is the same person.</p>
            </Section>
          )}

          {data.references && (
            <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
              <h2 className="text-lg font-semibold text-gray-800 mb-2">Backchannel references</h2>
              {!data.references.available ? (
                <p className="text-sm text-gray-600">
                  {data.references.reason}{' '}
                  <Link href="/network" className="text-blue-600 hover:underline">Open Network Map</Link>
                </p>
              ) : data.references.contacts.length === 0 ? (
                <p className="text-sm text-gray-600">
                  Nobody in your imported network works or worked at {data.references.companies.length ? data.references.companies.join(', ') : 'the companies found'}.
                </p>
              ) : (
                <>
                  <p className="text-xs text-gray-500 mb-2">People in your network at companies linked to {data.name}: potential reference checks. Your network data stays on this site.</p>
                  <ul className="divide-y divide-gray-100">
                    {data.references.contacts.map((c, i) => (
                      <li key={i} className="py-2 text-sm">
                        <span className="font-medium text-gray-800">{c.name}</span>
                        <span className="text-gray-600">{c.position ? ` · ${c.position}` : ''}{c.company ? ` at ${c.company}` : ''}</span>
                        {c.matchedCompany && <span className="ml-2 text-xs bg-blue-50 text-blue-700 rounded px-1.5 py-0.5">via {c.matchedCompany}</span>}
                        {c.profileUrl && <a href={c.profileUrl} target="_blank" rel="noopener noreferrer" className="ml-2 text-xs text-blue-600 hover:underline">profile</a>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

          {(data.warnings?.length > 0 || data.unavailableSources?.length > 0) && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4 text-sm text-yellow-900">
              {data.warnings?.length > 0 && (
                <ul className="list-disc ml-5 mb-2">
                  {data.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              )}
              {data.unavailableSources?.length > 0 && (
                <>
                  <p className="font-medium">Sources not searched:</p>
                  <ul className="list-disc ml-5">
                    {data.unavailableSources.map((u) => <li key={u.source}><strong>{u.source}</strong>: {u.reason}</li>)}
                  </ul>
                </>
              )}
            </div>
          )}

          <Section title="Career timeline" empty={!data.timeline.length}>
            <ol className="space-y-2">
              {data.timeline.map((t, i) => (
                <li key={i} className="flex gap-3">
                  <span className="font-semibold text-blue-700 w-12 shrink-0">{t.year}</span>
                  <Quote item={t} sources={sources} />
                </li>
              ))}
            </ol>
          </Section>

          <Section title="Past companies" empty={!data.pastCompanies.length}>
            <ul className="space-y-2">
              {data.pastCompanies.map((c, i) => (
                <li key={i}>
                  <span className="font-medium text-gray-800">{c.company}</span>
                  <Quote item={c} sources={sources} />
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Education" empty={!(data.education || []).length}>
            <ul className="space-y-2">
              {(data.education || []).map((e, i) => (
                <li key={i}>
                  <span className="font-medium text-gray-800">{e.school}</span>
                  <Quote item={e} sources={sources} />
                </li>
              ))}
            </ul>
          </Section>

          <Section
            title="Litigation and regulatory mentions"
            empty={!data.litigation.length}
            note={<p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded p-2 mb-2">{data.litigationDisclaimer}</p>}
          >
            <ul className="space-y-2">
              {data.litigation.map((l, i) => <li key={i}><Quote item={l} sources={sources} /></li>)}
            </ul>
          </Section>

          <Section title="Press" empty={!data.press.length}>
            <ul className="space-y-3">
              {data.press.map((p, i) => (
                <li key={i}>
                  <p className="text-sm font-medium text-gray-800">{p.title}</p>
                  <Quote item={p} sources={sources} />
                </li>
              ))}
            </ul>
          </Section>

          <section className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <h2 className="text-lg font-semibold text-gray-800 mb-2">Sources</h2>
            {sources.length === 0 ? (
              <p className="text-sm text-gray-500 italic">{EMPTY}</p>
            ) : (
              <ol className="text-sm space-y-1">
                {sources.map((s) => (
                  <li key={s.n} id={`source-${s.n}`}>
                    <span className="text-gray-500 mr-1">[{s.n}]</span>
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{s.title}</a>
                    <span className="text-gray-500"> · {s.sourceName}{s.date ? ` · ${s.date}` : ''}</span>
                  </li>
                ))}
              </ol>
            )}
            <p className="text-xs text-gray-400 mt-3">Generated {data.generatedAt}</p>
          </section>
        </>
      )}
    </PageShell>
  );
}
