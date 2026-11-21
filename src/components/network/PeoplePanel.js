/**
 * The people panel beside the globe: always the people behind the current
 * selection (a shortcut, Find, an answer, a click on the globe) or, with
 * none, the people in the part of the globe in view, with the groups there
 * as rows to fly to. A row opens in place with why the person is listed and
 * what to do next. Copy and Download CSV work on the listed people in the
 * browser; nothing is sent anywhere.
 */
import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { HiOutlineXMark, HiOutlineArrowTopRightOnSquare, HiOutlineMagnifyingGlass, HiOutlineSparkles, HiOutlineChevronDown, HiOutlineChevronRight } from 'react-icons/hi2';
import { classifyContact, familyOf } from '../../utils/network/roles';
import { seniority } from '../../utils/network/atlas';
import { listText, listCsv } from '../../utils/network/insights';
import { CheckMark, formatDate } from './checks';

export const PEOPLE_PAGE = 50;
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const SORTS = [{ key: 'senior', label: 'Most senior' }, { key: 'recent', label: 'Most recent' }, { key: 'name', label: 'A to Z' }];
const SOURCE_LABELS = { linkedin: 'LinkedIn', csv: 'CSV/XLSX', x: 'X', attio: 'Attio' };

/** "Mon YYYY" for a connected-on date. */
function monthYear(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
const byRecent = (a, b) => String(b.connectedOn || '').localeCompare(String(a.connectedOn || ''));
/** The people in another order; null keeps the selection's own order. */
export function sortPeople(list, sort) {
  if (!sort) return list;
  const out = [...list];
  if (sort === 'name') out.sort(byName);
  else if (sort === 'recent') out.sort((a, b) => byRecent(a, b) || byName(a, b));
  else out.sort((a, b) => seniority(a) - seniority(b) || byName(a, b));
  return out;
}

/** A file name from the panel's title: "network-investors-at-stripe.csv". */
function fileName(label) {
  const slug = String(label || 'people').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `network-${slug || 'people'}.csv`;
}

function Details({ c, reasons, onIntro }) {
  const kind = classifyContact(c);
  const why = [
    ...(reasons || []),
    !reasons?.length && kind.reason ? kind.reason : '',
    c.tags?.length ? `Tagged ${c.tags.join(', ')}` : '',
    c.connectedOn ? `Connected ${formatDate(c.connectedOn)}` : '',
  ].filter(Boolean);
  return (
    <div className="space-y-2 px-4 pb-3 pl-9 text-xs text-muted" data-testid="row-details">
      {why.length > 0 && <p>{why.join(' · ')}</p>}
      <dl className="space-y-0.5">
        {c.location && <div><dt className="inline font-medium text-slate-700">Location: </dt><dd className="inline">{c.location}</dd></div>}
        {c.email && <div><dt className="inline font-medium text-slate-700">Email: </dt><dd className="inline break-all">{c.email}</dd></div>}
        {c.source && <div><dt className="inline font-medium text-slate-700">From: </dt><dd className="inline">{SOURCE_LABELS[c.source] || c.source}</dd></div>}
        {c.relationship === 'firm' && <div><dt className="inline font-medium text-slate-700">Through: </dt><dd className="inline">{c.via || 'a colleague'} (a firm-wide contact, not your own connection)</dd></div>}
      </dl>
      <div className="flex flex-wrap gap-1.5">
        {c.company && <Link href={`/company/${encodeURIComponent(c.company)}`} className="btn-secondary px-2.5 py-1 text-xs">Company profile</Link>}
        <Link href={`/founder?name=${encodeURIComponent(c.name || '')}${c.company ? `&company=${encodeURIComponent(c.company)}` : ''}`} className="btn-secondary px-2.5 py-1 text-xs">Founder check</Link>
        {c.company && (
          <button type="button" onClick={() => onIntro(c.company)} className="btn-ghost px-2 py-1 text-xs">
            <HiOutlineSparkles style={{ width: 13, height: 13 }} /> Intro paths to {c.company}
          </button>
        )}
      </div>
    </div>
  );
}

/** One person: name, title · company, a role chip, the firm mark, Checked, profile link. Opens in place. */
export function PersonRow({ c, id, open, onOpen, reasons, showDate, onIntro }) {
  const fam = familyOf(c);
  return (
    <li data-person={id}>
      <div className="flex items-start gap-2 px-4 py-2 hover:bg-slate-50">
        <button type="button" onClick={() => onOpen(id)} aria-expanded={open} className="flex min-w-0 flex-1 items-start gap-2 text-left">
          <span className="mt-0.5 shrink-0 text-muted">
            {open ? <HiOutlineChevronDown style={{ width: 13, height: 13 }} /> : <HiOutlineChevronRight style={{ width: 13, height: 13 }} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              {c.relationship === 'firm' && <span className="inline-block h-2 w-2 shrink-0 rounded-full border border-brand-400" title="A firm-wide CRM contact, not your own connection" />}
              <span className="truncate text-sm font-medium text-ink">{c.name}</span>
              {!fam.catchAll && <span className="chip px-1.5 py-0">{fam.one}</span>}
            </span>
            <span className="block truncate text-xs text-muted">
              {[c.position, c.company].filter(Boolean).join(' · ') || 'No title or company'}
              {showDate && c.connectedOn ? ` · Connected ${monthYear(c.connectedOn)}` : ''}
            </span>
            {reasons?.length > 0 && !open && <span className="block truncate text-xs text-muted">{reasons.join(' · ')}</span>}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-1.5">
          <CheckMark name={c.name} company={c.company} />
          {c.profileUrl && (
            <a href={c.profileUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-brand-600 hover:text-brand-700" aria-label={`Profile of ${c.name}`} title="Open profile">
              <HiOutlineArrowTopRightOnSquare style={{ width: 13, height: 13 }} />
            </a>
          )}
        </span>
      </div>
      {open && <Details c={c} reasons={reasons} onIntro={onIntro} />}
    </li>
  );
}

function ListActions({ people, label }) {
  const [copied, setCopied] = useState('');
  if (!people.length) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(listText(people));
      setCopied('Copied');
    } catch {
      setCopied('Could not copy');
    }
    setTimeout(() => setCopied(''), 2000);
  };
  const download = () => {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(new Blob([listCsv(people)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName(label);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <span className="flex items-center gap-1">
      <button type="button" onClick={copy} className="btn-ghost px-2 py-0.5 text-xs" title="Names with title and company, one per line">{copied || 'Copy'}</button>
      <button type="button" onClick={download} className="btn-ghost px-2 py-0.5 text-xs" title="The listed people as a spreadsheet">Download CSV</button>
    </span>
  );
}

/** The people behind an answer, with the reasons under each and the intro-path sections. */
function AnswerBody({ answer, resolve, openId, onOpen, onIntro }) {
  const rows = (items, prefix = '') => (
    <ul className="divide-y divide-line">
      {items.map((r) => {
        const { c, id } = resolve(r.contact);
        return <PersonRow key={`${prefix}${id}`} c={c} id={`${prefix}${id}`} open={openId === `${prefix}${id}`} onOpen={onOpen} reasons={r.reasons} onIntro={onIntro} />;
      })}
    </ul>
  );
  const head = (text, n) => <h4 className="px-4 pb-1 pt-3 text-xs font-semibold text-ink">{text} <span className="font-normal text-muted">{fmt(n)}</span></h4>;
  // What the question was read as, in the engine's own plain phrases, so a
  // tag, industry or date question is explained as well as a company one.
  const f = answer.filters;
  const understood = Array.isArray(answer.understood) ? answer.understood : [
    ...(f?.companies || []).map((v) => `At ${v}`),
    ...(f?.roles || []),
    ...(f?.tags || []).map((v) => `Tagged “${v}”`),
    ...(f?.industries || []).map((v) => `In ${v}`),
    ...(f?.locations || []).map((v) => `In ${v}`),
    ...(f?.connected?.label ? [`Connected ${f.connected.label}`] : []),
    ...(f?.keywords || []).map((v) => `Mentions ${v}`),
  ];
  return (
    <div>
      {(understood.length > 0 || answer.parsedBy === 'llm') && (
        <div className="flex flex-wrap gap-1 px-4 pt-2" aria-label="Your question was read as">
          {understood.map((v) => <span key={v} className="chip">{v}</span>)}
          {answer.parsedBy === 'llm' && <span className="chip chip-active"><HiOutlineSparkles style={{ width: 12, height: 12 }} /> question read by AI (your contacts were not shared)</span>}
        </div>
      )}
      {answer.hiddenByFilters > 0 && <p className="px-4 pt-2 text-xs text-muted">{fmt(answer.hiddenByFilters)} more {answer.hiddenByFilters === 1 ? 'match is' : 'matches are'} hidden by the source filters above.</p>}
      {(answer.notes || []).filter((n) => !/^Past employees/.test(n)).map((n) => <p key={n} className="px-4 pt-2 text-xs text-amber-700">{n}</p>)}
      {answer.intent === 'intro-path' && answer.intro ? (
        <>
          {head(`Direct: people at ${answer.intro.target}`, answer.intro.direct.length)}
          {answer.intro.direct.length ? rows(answer.intro.direct) : <p className="px-4 text-xs text-muted">No one in your network lists {answer.intro.target} as their company.</p>}
          {answer.intro.possiblyRelated?.length > 0 && (
            <>
              {head('Possibly related', answer.intro.possiblyRelated.length)}
              <p className="px-4 text-xs text-muted">Similar company names, or {answer.intro.target} mentioned in a title. They may not work there.</p>
              {rows(answer.intro.possiblyRelated, 'rel:')}
            </>
          )}
          {head('Through its investors', answer.intro.viaInvestors.reduce((n, g) => n + g.total, 0))}
          {answer.intro.viaInvestors.length ? answer.intro.viaInvestors.map((g) => (
            <div key={g.investor}>
              <p className="px-4 pt-1 text-xs font-medium text-slate-700">{g.investor} <span className="font-normal text-muted">({g.evidence}; {g.total} {g.total === 1 ? 'contact' : 'contacts'})</span></p>
              {rows(g.contacts, `${g.investor}:`)}
            </div>
          )) : (
            <p className="px-4 text-xs text-muted">
              {answer.intro.investorsChecked?.length
                ? `You don't know anyone at the investors found for ${answer.intro.target} (${answer.intro.investorsChecked.slice(0, 8).join(', ')}${answer.intro.investorsChecked.length > 8 ? '…' : ''}).`
                : 'No paths through investors found.'}
            </p>
          )}
          <p className="px-4 py-3 text-xs text-muted">Past-employee paths are not available: contact exports only include the current company.</p>
        </>
      ) : (
        <>
          {answer.results?.length ? rows(answer.results) : (
            <p className="px-4 py-6 text-center text-xs text-muted">No one in your network matches that. Try a company name, a role like &quot;engineers&quot;, or a place.</p>
          )}
          {answer.total > (answer.results?.length || 0) && <p className="px-4 py-2 text-xs text-muted">Top {fmt(answer.results.length)} of {fmt(answer.total)} shown.</p>}
          {answer.possiblyRelated?.results?.length > 0 && (
            <>
              {head('Possibly related', answer.possiblyRelated.total)}
              <p className="px-4 text-xs text-muted">Similar company names, or the company mentioned in a title. They may not work there.</p>
              {rows(answer.possiblyRelated.results, 'rel:')}
            </>
          )}
        </>
      )}
    </div>
  );
}

export default function PeoplePanel({
  title, count, active, onClear, people, listOrder, find, onFind, groups = [], onGroup,
  openId, onOpen, onIntro, company, answer, asking, resolve, idOf, heightClass = '',
}) {
  const [sort, setSort] = useState(null);
  const [shown, setShown] = useState(PEOPLE_PAGE);
  // A new list starts in its own order, from the top.
  useEffect(() => { setSort(null); setShown(PEOPLE_PAGE); }, [people, answer]);
  const sorted = useMemo(() => sortPeople(people, sort), [people, sort]);
  const current = sort || listOrder;
  const answerPeople = useMemo(() => {
    if (!answer) return [];
    const seen = new Set();
    const out = [];
    const add = (r) => { const { c, id } = resolve(r.contact); if (!seen.has(id)) { seen.add(id); out.push(c); } };
    (answer.results || []).forEach(add);
    (answer.intro?.direct || []).forEach(add);
    (answer.intro?.viaInvestors || []).forEach((g) => g.contacts.forEach(add));
    return out;
  }, [answer, resolve]);
  const listed = answer ? answerPeople : sorted;

  return (
    <aside className={`flex min-h-0 flex-col bg-white ${heightClass}`} aria-label="People">
      <div className="space-y-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate font-semibold text-ink" data-testid="panel-title">
            {answer ? 'Answer' : title} <span className="font-normal text-muted">· {fmt(answer ? answer.total ?? answerPeople.length : count)}</span>
          </h3>
          {(active || answer) && (
            <button type="button" onClick={onClear} className="btn-ghost px-2 py-0.5 text-xs" aria-label="Clear the selection">
              <HiOutlineXMark style={{ width: 13, height: 13 }} /> Clear
            </button>
          )}
        </div>
        <div className="relative">
          <HiOutlineMagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" style={{ width: 14, height: 14 }} />
          <input
            type="search"
            value={find}
            onChange={(e) => onFind(e.target.value)}
            placeholder="Find a name, company or title"
            aria-label="Find a person or company"
            className="input py-1.5 pl-8 text-sm"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {!answer && (
            <div className="flex rounded-lg border border-line p-0.5 text-xs" role="radiogroup" aria-label="Sort people">
              {SORTS.map((o) => (
                <button key={o.key} type="button" role="radio" aria-checked={current === o.key} onClick={() => setSort(o.key)} className={`rounded-md px-2 py-0.5 ${current === o.key ? 'bg-slate-100 font-medium text-ink' : 'text-muted hover:text-ink'}`}>{o.label}</button>
              ))}
            </div>
          )}
          <ListActions people={listed} label={answer ? 'answer' : title} />
        </div>
        {company && !answer && (
          <div className="flex flex-wrap gap-1.5">
            <Link href={`/company/${encodeURIComponent(company)}`} className="btn-secondary px-2.5 py-1 text-xs">Company profile</Link>
            <button type="button" onClick={() => onIntro(company)} className="btn-ghost px-2 py-1 text-xs">
              <HiOutlineSparkles style={{ width: 13, height: 13 }} /> Intro paths to {company}
            </button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {asking && (
          <div aria-busy="true" className="space-y-2 px-4 py-3">
            <p className="text-xs text-ink">Searching your contacts…</p>
            <div className="skeleton h-3 w-2/3" />
            <div className="skeleton h-3 w-1/2" />
          </div>
        )}
        {answer && !asking ? (
          <AnswerBody answer={answer} resolve={resolve} openId={openId} onOpen={onOpen} onIntro={onIntro} />
        ) : !asking && (
          <>
            {!active && groups.length > 1 && (
              <ul className="space-y-1 border-b border-line px-4 py-3" aria-label="Groups in view">
                {groups.map((g) => (
                  <li key={g.id}>
                    <button type="button" onClick={() => onGroup(g.id)} className="group flex w-full items-center gap-2 text-left text-xs" title={g.hint || `Fly to ${g.label}`}>
                      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: g.color }} />
                      <span className="min-w-0 flex-1 truncate text-ink group-hover:underline">{g.label}</span>
                      <span className="shrink-0 tabular-nums text-muted">{fmt(g.count)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <ul className="divide-y divide-line" data-testid="people-list">
              {sorted.slice(0, shown).map((c) => {
                const id = idOf(c);
                return <PersonRow key={id} c={c} id={id} open={openId === id} onOpen={onOpen} showDate={current === 'recent'} onIntro={onIntro} />;
              })}
              {sorted.length === 0 && <li className="px-4 py-8 text-center text-xs text-muted">No one here matches.</li>}
              {sorted.length > shown && (
                <li className="px-4 py-2 text-center">
                  <button type="button" onClick={() => setShown((n) => n + PEOPLE_PAGE)} className="text-xs font-medium text-brand-600 hover:underline">
                    Show {fmt(Math.min(PEOPLE_PAGE, sorted.length - shown))} more of {fmt(sorted.length)}
                  </button>
                </li>
              )}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}
