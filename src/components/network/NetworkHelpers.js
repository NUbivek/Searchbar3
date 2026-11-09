/**
 * "Your network" panel for Open Research, company profiles and Founder
 * Check: who you know at the company, at its investors and competitors, and
 * which experts and investors in your network cover its sector. Reads
 * /api/network/helpers (the signed-in user's own contacts; nothing is sent
 * anywhere else).
 */
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { HiOutlineShare, HiOutlineArrowTopRightOnSquare } from 'react-icons/hi2';

const ROLE_CHIP = {
  lp: 'chip-good', investor: 'chip-good', founder: 'chip-active', executive: 'chip-active',
};

function Person({ row }) {
  const c = row.contact;
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-ink">{c.name}</span>
          {row.roleLabel && row.role !== 'other' && <span className={`chip ${ROLE_CHIP[row.role] || ''}`}>{row.roleLabel}</span>}
        </div>
        <div className="truncate text-xs text-slate-600">{[c.position, c.company].filter(Boolean).join(' · ')}</div>
        {row.reasons?.length > 0 && <div className="text-[11px] text-muted">{row.reasons.slice(0, 2).join(' · ')}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {c.profileUrl && (
          <a href={c.profileUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
            Profile <HiOutlineArrowTopRightOnSquare style={{ width: 12, height: 12 }} />
          </a>
        )}
      </div>
    </li>
  );
}

const SHOW_FIRST = 6;

function Group({ title, hint, rows, empty }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, SHOW_FIRST);
  return (
    <div>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        {title} <span className="chip">{rows.length}</span>
      </h3>
      {hint && <p className="text-xs text-muted">{hint}</p>}
      {rows.length ? (
        <>
          <ul className="mt-1 divide-y divide-line">{shown.map((r, i) => <Person key={`${r.contact.name}-${r.contact.company}-${i}`} row={r} />)}</ul>
          {rows.length > SHOW_FIRST && (
            <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 text-xs font-medium text-brand-600 hover:underline">
              {all ? 'Show fewer' : `Show all ${rows.length}`}
            </button>
          )}
        </>
      ) : (
        <p className="muted mt-1 text-xs">{empty}</p>
      )}
    </div>
  );
}

/**
 * @param {object} props
 * @param {string} props.company       the company in question
 * @param {string[]} [props.related]   its investors / competitors
 * @param {string[]} [props.keywords]  industry words for expert matching
 * @param {string} [props.person]      founder name (Founder Check)
 * @param {string} [props.title]
 */
export default function NetworkHelpers({ company, related = [], keywords = [], person = '', title = 'Your network' }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const key = JSON.stringify({ company, related, keywords, person });

  useEffect(() => {
    let cancelled = false;
    if (!company && !keywords.length) { setState({ loading: false, data: null, error: '' }); return undefined; }
    setState({ loading: true, data: null, error: '' });
    fetch('/api/network/helpers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companies: [company, ...related].filter(Boolean), keywords, person }),
    })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`); return d; })
      .then((data) => { if (!cancelled) setState({ loading: false, data, error: '' }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, data: null, error: e.message }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const { loading, data, error } = state;
  const total = data?.available ? data.atCompany.length + data.atRelated.length + data.experts.length + data.investors.length : 0;

  return (
    <section className="card card-pad" aria-labelledby="network-helpers-heading">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="network-helpers-heading" className="section-title flex items-center gap-2">
          <HiOutlineShare className="text-brand-500" style={{ width: 16, height: 16 }} /> {title}
          {data?.available && <span className="chip">{total}</span>}
        </h2>
        <Link href="/network" className="text-xs font-medium text-brand-600 hover:underline">Open Network Map</Link>
      </div>
      {loading && <div className="space-y-2"><div className="skeleton h-4 w-1/3" /><div className="skeleton h-3 w-2/3" /></div>}
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {data && !data.available && (
        <p className="muted">{data.reason} <Link href="/network" className="font-medium text-brand-600 hover:underline">Open Network Map</Link></p>
      )}
      {data?.available && (
        <div className="space-y-4">
          <p className="text-xs text-muted">
            Checked {Number(data.checked).toLocaleString('en-US')} saved contacts{company ? ` against ${company}` : ''}{data.companies.length > 1 ? ` and ${data.companies.length - 1} related compan${data.companies.length === 2 ? 'y' : 'ies'}` : ''}{keywords.length ? `, plus "${keywords.join('", "')}" for experts and investors` : ''}. Your contacts stay on this site.
          </p>
          {company && (
            <Group
              title={`At ${company}`}
              hint={person ? `Worked alongside ${person}: reference calls and backchannel.` : 'Current and former staff: customers, references, what it is like inside.'}
              rows={data.atCompany}
              empty={`Nobody in your network lists ${company} as their company.`}
            />
          )}
          {data.companies.length > 1 && (
            <Group
              title="At investors and related companies"
              hint={`People at ${data.companies.slice(1, 4).join(', ')}${data.companies.length > 4 ? ` and ${data.companies.length - 4} more` : ''}: intro paths and a view from the cap table.`}
              rows={data.atRelated}
              empty="Nobody in your network works at the related companies found."
            />
          )}
          {keywords.length > 0 && (
            <>
              <Group
                title="Experts who can diligence this sector"
                hint="Founders, operators, researchers and advisors in your network whose title or company mentions the sector."
                rows={data.experts}
                empty="No sector experts matched; try the Network Map with a different industry word."
              />
              <Group
                title="Investors and LPs in this sector"
                hint="Who could co-invest, lead, or point you to the right fund."
                rows={data.investors}
                empty="No investors in your network match this sector."
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}
