/**
 * The people panel beside the globe: always the people behind the current
 * selection (a shortcut, Find, an answer, a click on the globe) or, with
 * none, the people in the part of the globe in view, with the groups there
 * as rows to fly to. A row opens in place with why the person is listed and
 * what to do next. Copy and Download CSV work on the listed people in the
 * browser; nothing is sent anywhere.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { HiOutlineXMark, HiOutlineArrowTopRightOnSquare, HiOutlineMagnifyingGlass, HiOutlineSparkles, HiOutlineChevronDown, HiOutlineChevronRight } from 'react-icons/hi2';
import { classifyContact, familyOf } from '../../utils/network/roles';
import { seniority } from '../../utils/network/atlas';
import { listText, listCsv } from '../../utils/network/insights';
import { CheckMark, formatDate } from './checks';

export const PEOPLE_PAGE = 50;
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const SORTS = [{ key: 'senior', label: 'Most senior' }, { key: 'recent', label: 'Most recent' }, { key: 'name', label: 'A to Z' }];
const SORT_KEYS = new Set(SORTS.map((o) => o.key));
// Below the sm breakpoint small controls are at least 36px tall, a size a thumb can hit.
const TAP = 'min-h-9 sm:min-h-0';
const nPeople = (n) => `${fmt(n)} ${n === 1 ? 'person' : 'people'}`;

/**
 * Radio buttons that behave as a radio group should: one Tab stop (the
 * checked option, or the first), the arrow keys move and choose, Home and
 * End jump. Used for "Sort people" here and "Arrange by" on the page.
 */
export function RadioGroup({ label, options, isChecked, onChange, className = '', buttonClass }) {
  const refs = useRef([]);
  const checkedAt = options.findIndex((o) => isChecked(o.key));
  const onKeyDown = (event, i) => {
    const last = options.length - 1;
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const to = next > last ? 0 : next < 0 ? last : next;
    onChange(options[to].key);
    refs.current[to]?.focus();
  };
  return (
    <div className={className} role="radiogroup" aria-label={label}>
      {options.map((o, i) => {
        const on = isChecked(o.key);
        return (
          <button
            key={String(o.key)}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === (checkedAt < 0 ? 0 : checkedAt) ? 0 : -1}
            onClick={() => onChange(o.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={buttonClass(on)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * What a question was read as, in the engine's own plain phrases, so a tag,
 * industry or date question is explained as well as a company one. An older
 * reply without `understood` is explained from its filters.
 */
export function understoodOf(answer) {
  if (!answer) return [];
  if (Array.isArray(answer.understood)) return answer.understood;
  const f = answer.filters;
  return [
    ...(f?.companies || []).map((v) => `At ${v}`),
    ...(f?.roles || []),
    ...(f?.tags || []).map((v) => `Tagged “${v}”`),
    ...(f?.industries || []).map((v) => `In ${v}`),
    ...(f?.locations || []).map((v) => `In ${v}`),
    ...(f?.connected?.label ? [`Connected ${f.connected.label}`] : []),
    ...(f?.keywords || []).map((v) => `Mentions ${v}`),
  ];
}
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

/**
 * Why a person is counted in their role, in plain words ("Counted as an
 * investor from the title"), never the classifier's own reason line.
 */
function countedAs(c) {
  const fam = familyOf(c);
  if (!fam || fam.catchAll) return '';
  const reason = String(classifyContact(c).reason || '');
  const from = /^Title and company/.test(reason) ? ' from the title and company'
    : /^Company/.test(reason) ? ' from the company' : reason ? ' from the title' : '';
  return `Counted as ${/^[aeiou]/i.test(fam.one) ? 'an' : 'a'} ${fam.one}${from}`;
}

function Details({ c, reasons, onIntro }) {
  const why = [
    ...(reasons || []),
    !reasons?.length ? countedAs(c) : '',
    c.tags?.length ? `Tagged ${c.tags.map((t) => `“${t}”`).join(', ')}` : '',
    c.connectedOn ? `Connected ${monthYear(c.connectedOn) || formatDate(c.connectedOn)}` : '',
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
        {c.company && <Link href={`/?q=${encodeURIComponent(c.company)}`} className="btn-secondary px-2.5 py-1 text-xs">Search company</Link>}
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
  // The short row tag ("Founder or CEO"); the two catch-all families have none.
  const tag = fam.tag !== undefined ? fam.tag : fam.catchAll ? '' : fam.one;
  return (
    <li data-person={id}>
      <div className="flex items-start gap-2 px-4 py-2 hover:bg-slate-50">
        <button type="button" onClick={onOpen} aria-expanded={open} className="flex min-w-0 flex-1 items-start gap-2 text-left">
          <span className="mt-0.5 shrink-0 text-muted">
            {open ? <HiOutlineChevronDown style={{ width: 13, height: 13 }} /> : <HiOutlineChevronRight style={{ width: 13, height: 13 }} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              {c.relationship === 'firm' && (
                <>
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full border border-brand-400" title="A firm-wide CRM contact, not your own connection" aria-hidden="true" />
                  <span className="sr-only">Firm contact, through {c.via || 'a colleague'}:</span>
                </>
              )}
              <span className="truncate text-sm font-medium text-ink">{c.name}</span>
              {tag && <span className="chip px-1.5 py-0">{tag}</span>}
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
            <a href={c.profileUrl} target="_blank" rel="noopener noreferrer nofollow" className={`inline-flex min-w-9 items-center justify-center text-brand-600 hover:text-brand-700 sm:min-w-0 ${TAP}`} aria-label={`Profile of ${c.name}`} title="Open profile">
              <HiOutlineArrowTopRightOnSquare style={{ width: 13, height: 13 }} />
            </a>
          )}
        </span>
      </div>
      {open && <Details c={c} reasons={reasons} onIntro={onIntro} />}
    </li>
  );
}

// A byte-order mark first, so Excel reads the file as UTF-8 and accented names stay whole.
const BOM = '\uFEFF';

function ListActions({ people, label }) {
  // What the last Copy or Download did: { what: 'copy'|'download', text }.
  const [said, setSaid] = useState(null);
  // The message clears itself after two seconds; the timer goes with the list.
  useEffect(() => {
    if (!said) return undefined;
    const t = setTimeout(() => setSaid(null), 2000);
    return () => clearTimeout(t);
  }, [said]);
  if (!people.length) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(listText(people));
      setSaid({ what: 'copy', text: 'Copied' });
    } catch {
      setSaid({ what: 'copy', text: 'Could not copy' });
    }
  };
  const download = () => {
    try {
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') throw new Error('no download');
      const url = URL.createObjectURL(new Blob([BOM, listCsv(people)], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName(label);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setSaid({ what: 'download', text: 'Could not download' });
    }
  };
  return (
    <span className="flex items-center gap-1">
      <button type="button" onClick={copy} className={`btn-ghost px-2 py-0.5 text-xs ${TAP}`} title="Names with title and company, one per line">{said?.what === 'copy' ? said.text : 'Copy'}</button>
      <button type="button" onClick={download} className={`btn-ghost px-2 py-0.5 text-xs ${TAP}`} title="The listed people as a spreadsheet">{said?.what === 'download' ? said.text : 'Download CSV'}</button>
      <span className="sr-only" role="status" data-testid="copy-status">{said ? said.text : ''}</span>
    </span>
  );
}

/** "Show 50 more of 112" under a list cut into pages. */
function More({ total, shown, onMore }) {
  if (total <= shown) return null;
  return (
    <li className="px-4 py-2 text-center">
      <button type="button" onClick={onMore} className="text-xs font-medium text-brand-600 hover:underline">
        Show {fmt(Math.min(PEOPLE_PAGE, total - shown))} more of {fmt(total)}
      </button>
    </li>
  );
}

/**
 * The people behind an answer. `people` is everyone the answer found (from
 * its uncapped `keys`, page-2), in rank order: every one is listed, a page
 * at a time, with the engine's reasons under those it gave reasons for. An
 * intro-path answer lists the direct people, then the people at the
 * company's investors; "possibly related" people are listed apart and are
 * not part of the answer's count.
 */
function AnswerBody({ answer, people, idOf, resolve, isOpen, openRow, onIntro, shown, onMore }) {
  // The engine's reasons per person id, from every section that has them.
  const reasonsById = useMemo(() => {
    const m = new Map();
    const add = (r) => { const { id } = resolve(r.contact); if (!m.has(id) && r.reasons?.length) m.set(id, r.reasons); };
    (answer.results || []).forEach(add);
    (answer.intro?.direct || []).forEach(add);
    (answer.intro?.viaInvestors || []).forEach((g) => (g.contacts || []).forEach(add));
    return m;
  }, [answer, resolve]);
  // The section prefix only keeps React keys apart; the person id stays bare,
  // so an opened row is marked on the globe.
  const personRows = (list, prefix = '') => list.map((c) => {
    const id = idOf(c);
    const key = `${prefix}${id}`;
    return <PersonRow key={key} c={c} id={id} open={isOpen(key, id)} onOpen={() => openRow(key, id)} reasons={reasonsById.get(id)} onIntro={onIntro} />;
  });
  const rows = (items, prefix = '') => (
    <ul className="divide-y divide-line">
      {items.map((r) => {
        const { c, id } = resolve(r.contact);
        const key = `${prefix}${id}`;
        return <PersonRow key={key} c={c} id={id} open={isOpen(key, id)} onOpen={() => openRow(key, id)} reasons={r.reasons} onIntro={onIntro} />;
      })}
    </ul>
  );
  const head = (text, n) => <h4 className="px-4 pb-1 pt-3 text-xs font-semibold text-ink">{text} <span className="font-normal text-muted">{fmt(n)}</span></h4>;
  const understood = understoodOf(answer);
  const intro = answer.intent === 'intro-path' && answer.intro ? answer.intro : null;
  // Intro paths: the direct people are the answer's own keys; everyone else
  // listed came through an investor.
  const directIds = useMemo(() => {
    if (!intro) return null;
    const keys = Array.isArray(intro.keys) ? intro.keys : Array.isArray(answer.keys) ? answer.keys : null;
    if (keys) return new Set(keys.map((k) => `p:${k}`));
    return new Set((intro.direct || []).map((r) => resolve(r.contact).id));
  }, [intro, answer, resolve]);
  const direct = intro ? people.filter((c) => directIds.has(idOf(c))) : [];
  return (
    <div>
      {(understood.length > 0 || answer.parsedBy === 'llm') && (
        <div className="flex flex-wrap gap-1 px-4 pt-2" aria-label="Your question was read as">
          {understood.map((v) => <span key={v} className="chip">{v}</span>)}
          {answer.parsedBy === 'llm' && <span className="chip chip-active"><HiOutlineSparkles style={{ width: 12, height: 12 }} /> question read by AI (your contacts were not shared)</span>}
        </div>
      )}
      {answer.hiddenByFilters > 0 && <p className="px-4 pt-2 text-xs text-muted">{fmt(answer.hiddenByFilters)} more {answer.hiddenByFilters === 1 ? 'match is' : 'matches are'} hidden by {answer.hiddenBy || 'the source filters above'}.</p>}
      {(answer.notes || []).filter((n) => !/^Past employees/.test(n)).map((n) => <p key={n} className="px-4 pt-2 text-xs text-amber-700">{n}</p>)}
      {intro ? (
        <>
          {head(`Direct: people at ${intro.target}`, direct.length)}
          {direct.length ? (
            <ul className="divide-y divide-line">
              {personRows(direct.slice(0, shown))}
              <More total={direct.length} shown={shown} onMore={onMore} />
            </ul>
          ) : <p className="px-4 text-xs text-muted">No one in your network lists {intro.target} as their company.</p>}
          {intro.possiblyRelated?.length > 0 && (
            <>
              {head('Possibly related', intro.possiblyRelated.length)}
              <p className="px-4 text-xs text-muted">Similar company names, or {intro.target} mentioned in a title. They may not work there.</p>
              {rows(intro.possiblyRelated, 'rel:')}
            </>
          )}
          {head('Through its investors', (intro.viaInvestors || []).reduce((n, g) => n + g.total, 0))}
          {intro.viaInvestors?.length ? intro.viaInvestors.map((g) => (
            <div key={g.investor}>
              <p className="px-4 pt-1 text-xs font-medium text-slate-700">{g.investor} <span className="font-normal text-muted">({g.evidence}; {g.total} {g.total === 1 ? 'contact' : 'contacts'})</span></p>
              {rows(g.contacts, `${g.investor}:`)}
            </div>
          )) : (
            <p className="px-4 text-xs text-muted">
              {intro.investorsChecked?.length
                ? `You don't know anyone at the investors found for ${intro.target} (${intro.investorsChecked.slice(0, 8).join(', ')}${intro.investorsChecked.length > 8 ? '…' : ''}).`
                : 'No paths through investors found.'}
            </p>
          )}
          <p className="px-4 py-3 text-xs text-muted">Past-employee paths are not available: contact exports only include the current company.</p>
        </>
      ) : (
        <>
          {people.length ? (
            <ul className="divide-y divide-line" data-testid="answer-list">
              {personRows(people.slice(0, shown))}
              <More total={people.length} shown={shown} onMore={onMore} />
            </ul>
          ) : (
            <p className="px-4 py-6 text-center text-xs text-muted">No one in your network matches that. Try a company name, a role like &quot;engineers&quot;, or a place.</p>
          )}
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

/**
 * "Narrow to" (ROUND2 R1): other shortcuts that would narrow the list, each
 * with how many people it would leave; and, once the list is narrowed, its
 * parts as small chips that each widen it again when removed.
 */
function Narrowing({ narrow, onNarrow, parts, onRemovePart }) {
  if (!narrow.length && parts.length < 2) return null;
  return (
    <div className="space-y-1.5">
      {parts.length >= 2 && (
        <div className="flex flex-wrap items-center gap-1" aria-label="This list is">
          {parts.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onRemovePart(p.id)}
              className={`chip chip-active gap-1 px-2 py-0 text-xs ${TAP}`}
              aria-label={`Remove ${p.label} from this list`}
              title="Remove to widen the list"
            >
              {p.label} <HiOutlineXMark style={{ width: 11, height: 11 }} />
            </button>
          ))}
        </div>
      )}
      {narrow.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Narrow to">
          <span className="text-xs text-muted">Narrow to</span>
          {narrow.map((n) => (
            <button key={n.id} type="button" data-narrow={n.id} onClick={() => onNarrow(n.id)} className={`chip px-2 py-0 text-xs hover:border-brand-200 hover:text-ink ${TAP}`}>
              {n.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PeoplePanel({
  title, count, active, onClear, people, listOrder, find, onFind, groups = [], onGroup,
  openId, onOpen, onIntro, company, answer, asking, resolve, idOf, downloadName, heightClass = '',
  narrow = [], onNarrow, parts = [], onRemovePart,
}) {
  const [sort, setSort] = useState(null);
  const [shown, setShown] = useState(PEOPLE_PAGE);
  // On a phone the group rows fold to one line, so people show first.
  const [groupsOpen, setGroupsOpen] = useState(false);
  // Which row is open when one person sits in several answer sections:
  // { key, id }. The page keeps only the bare person id.
  const [openRowKey, setOpenRowKey] = useState(null);
  const findRef = useRef(null);
  // A new list starts in its own order, from the top. The page hands over a
  // new array only when the selection (or, with none, the part in view) changes.
  useEffect(() => { setSort(null); setShown(PEOPLE_PAGE); }, [people, answer]);
  const sorted = useMemo(() => sortPeople(people, sort), [people, sort]);
  const current = sort || listOrder;
  // An answer lists, copies and downloads everyone it found: the page hands
  // over its people from the answer's uncapped keys, so `people` and `count`
  // are the same people the globe lights (page-2, page-7).
  const listed = answer ? people : sorted;
  const shownCount = count;

  // A row is open when its person is the page's open person and, if the
  // panel opened it, it is that very row.
  const isOpen = (key, id) => openId === id && (!openRowKey || openRowKey.id !== id || openRowKey.key === key);
  const openRow = (key, id) => {
    if (isOpen(key, id)) { setOpenRowKey(null); onOpen(null); return; }
    setOpenRowKey({ key, id });
    onOpen(id);
  };

  // The sort choices that do something here: "Most recent" only when someone
  // listed has a connection date, and "Default" for a list with its own order
  // (senior leaders by company size) so that order can be had back.
  const hasDates = useMemo(() => people.some((c) => c && c.connectedOn), [people]);
  const ownOrder = Boolean(listOrder) && !SORT_KEYS.has(listOrder);
  const sortOptions = [
    ...(ownOrder ? [{ key: null, label: 'Default' }] : []),
    ...SORTS.filter((o) => o.key !== 'recent' || hasDates),
  ];
  const sortChecked = (key) => (key === null ? !sort : current === key);

  const clear = () => {
    onClear();
    // The Clear button goes away with the selection; keep the keyboard in the panel.
    findRef.current?.focus();
  };

  // Said to screen readers when the list changes.
  const status = asking ? 'Searching your contacts…'
    : answer ? (shownCount ? `${title}: ${nPeople(shownCount)}` : 'No matches')
      : active ? `${title}: ${nPeople(count)}` : '';

  return (
    <aside
      className={`flex min-h-0 flex-col bg-white ${heightClass}`}
      aria-label="People"
      // Escape anywhere in the list clears the selection, as it does on the map (R5).
      onKeyDown={(e) => { if (e.key === 'Escape' && (active || answer)) { e.preventDefault(); clear(); } }}
    >
      <p className="sr-only" role="status" data-testid="panel-status">{status}</p>
      <div className="space-y-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          {/* The label can be cut short; the count beside it never is. */}
          <h3 className="flex min-w-0 flex-1 items-baseline gap-1 font-semibold text-ink" data-testid="panel-title">
            <span className="min-w-0 truncate">{title}</span>{' '}
            <span className="shrink-0 font-normal text-muted" data-testid="panel-count">· {fmt(shownCount)}</span>
          </h3>
          {(active || answer) && (
            <button type="button" onClick={clear} className={`btn-ghost px-2 py-0.5 text-xs ${TAP}`} aria-label="Clear the selection">
              <HiOutlineXMark style={{ width: 13, height: 13 }} /> Clear
            </button>
          )}
        </div>
        <div className="relative">
          <HiOutlineMagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" style={{ width: 14, height: 14 }} />
          <input
            ref={findRef}
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
            <RadioGroup
              label="Sort people"
              className="flex rounded-lg border border-line p-0.5 text-xs"
              options={sortOptions}
              isChecked={sortChecked}
              onChange={setSort}
              buttonClass={(on) => `rounded-md px-2 py-0.5 ${TAP} ${on ? 'bg-slate-100 font-medium text-ink' : 'text-muted hover:text-ink'}`}
            />
          )}
          <ListActions people={listed} label={downloadName || title} />
        </div>
        <Narrowing narrow={narrow} onNarrow={onNarrow} parts={parts} onRemovePart={onRemovePart} />
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
          <AnswerBody answer={answer} people={people} idOf={idOf} resolve={resolve} isOpen={isOpen} openRow={openRow} onIntro={onIntro} shown={shown} onMore={() => setShown((n) => n + PEOPLE_PAGE)} />
        ) : !asking && (
          <>
            {!active && groups.length > 1 && (
              <div className="border-b border-line">
                <button
                  type="button"
                  onClick={() => setGroupsOpen((v) => !v)}
                  aria-expanded={groupsOpen}
                  className="flex min-h-9 w-full items-center gap-1.5 px-4 py-2 text-left text-xs text-muted hover:text-ink lg:hidden"
                >
                  {groupsOpen ? <HiOutlineChevronDown style={{ width: 13, height: 13 }} /> : <HiOutlineChevronRight style={{ width: 13, height: 13 }} />}
                  {fmt(groups.length)} groups here
                </button>
                <ul className={`${groupsOpen ? '' : 'hidden '}space-y-1 px-4 pb-3 lg:block lg:pt-3`} aria-label="Groups in view">
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
              </div>
            )}
            <ul className="divide-y divide-line" data-testid="people-list">
              {sorted.slice(0, shown).map((c) => {
                const id = idOf(c);
                return <PersonRow key={id} c={c} id={id} open={isOpen(id, id)} onOpen={() => openRow(id, id)} showDate={current === 'recent'} onIntro={onIntro} />;
              })}
              {sorted.length === 0 && <li className="px-4 py-8 text-center text-xs text-muted">No one here matches.</li>}
              <More total={sorted.length} shown={shown} onMore={() => setShown((n) => n + PEOPLE_PAGE)} />
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}
