/**
 * "Your network" on a deep check report: whether the person is one of the
 * user's own contacts, who the user knows around them (grouped and ranked),
 * and the five best people to call for a reference. The data comes with the
 * report (report.network, built by server/founder/networkLink.js) and is the
 * signed-in user's own; it is never shown to anyone else.
 *
 * Same markup and classes as the report's other sections (DeepCheck.js Block).
 */
import React, { useState } from 'react';
import Link from 'next/link';
import { HiOutlineArrowTopRightOnSquare } from 'react-icons/hi2';

function Section({ title, count, children, open = false, note = null }) {
  return (
    <details className="card card-pad group" open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <h2 className="section-title">{title}</h2>
        {typeof count === 'number' && <span className="chip">{count}</span>}
        <span className="ml-auto text-xs text-muted group-open:hidden">Show</span>
        <span className="ml-auto hidden text-xs text-muted group-open:inline">Hide</span>
      </summary>
      <div className="mt-3">
        {note}
        {children}
      </div>
    </details>
  );
}

export function connectedSince(date) {
  const d = date ? new Date(`${String(date).slice(0, 10)}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function Relationship({ p }) {
  if (p.relationship === 'firm') {
    return <span className="chip chip-warn" title="A firm-wide contact, not your own connection">{p.via ? `via ${p.via}` : 'firm contact'}</span>;
  }
  return <span className="chip chip-good">your contact</span>;
}

function Person({ p, children = null }) {
  const since = connectedSince(p.connectedOn);
  return (
    <li className="py-2.5 text-sm first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-1.5">
        {p.profileUrl
          ? (
            <a href={p.profileUrl} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-ink hover:text-brand-600 hover:underline">
              {p.name} <HiOutlineArrowTopRightOnSquare className="inline align-text-top text-muted" style={{ width: 12, height: 12 }} />
            </a>
          )
          : <span className="font-medium text-ink">{p.name}</span>}
        <Relationship p={p} />
        {since && <span className="text-xs text-muted">connected {since}</span>}
      </div>
      {(p.position || p.company) && <p className="text-slate-700">{[p.position, p.company].filter(Boolean).join(' · ')}</p>}
      {p.why && <p className="text-xs text-muted">{p.why}</p>}
      {children}
    </li>
  );
}

function Group({ g }) {
  const [all, setAll] = useState(false);
  const first = 6;
  const shown = all ? g.people : g.people.slice(0, first);
  return (
    <div>
      <p className="eyebrow mb-1.5">
        {g.title} · {g.total}{g.total > g.people.length ? ` (showing the top ${g.people.length})` : ''}
      </p>
      {g.companies?.length > 0 && <p className="mb-1.5 text-xs text-muted">{g.companies.join(', ')}</p>}
      <ul className="divide-y divide-line">{shown.map((p) => <Person key={`${p.name}|${p.company}`} p={p} />)}</ul>
      {g.people.length > first && (
        <button type="button" className="btn-ghost mt-2 px-2 py-1 text-xs" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? 'Show fewer' : `Show all ${g.people.length}`}
        </button>
      )}
    </div>
  );
}

const importLink = <Link href="/network" className="font-medium text-brand-600 hover:underline">Network Map</Link>;

export default function NetworkLinks({ network, name }) {
  if (!network) return null;
  if (!network.available) {
    return (
      <Section title="Your network">
        <p className="muted text-sm">{network.reason || 'Import your network in the Network Map tab to see who you know around this person.'}</p>
        <p className="mt-2 text-xs text-muted">Open the {importLink} tab to import your contacts.</p>
      </Section>
    );
  }
  const { self, sameNameContacts = [], groups = [], references = [], counts = {}, notes = [] } = network;
  const person = name || 'this person';
  return (
    <>
      <Section
        title="In your network"
        count={(self ? 1 : 0) + sameNameContacts.length}
        open={Boolean(self || sameNameContacts.length)}
        note={<p className="muted mb-3 text-xs">Matched by full name against the {network.checked ?? ''} contacts in your {importLink}. Only you can see this.</p>}
      >
        {network.seededCompany && (
          <p className="mb-3 rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs text-slate-700">
            No company was entered, so this check used {network.seededCompany}, the company of the one contact in your network named {person}.
          </p>
        )}
        {self ? (
          <ul><Person p={{ ...self, why: self.note }} /></ul>
        ) : (
          <p className="text-sm text-slate-700">{sameNameContacts.length ? `${person} is not clearly one of your contacts.` : `${person} is not one of your contacts.`}</p>
        )}
        {sameNameContacts.length > 0 && (
          <div className="mt-3">
            <p className="eyebrow mb-1.5">A contact with this name{sameNameContacts.length === 1 ? '' : ` (${sameNameContacts.length})`}</p>
            <p className="mb-1.5 text-xs text-muted">Same name, but nothing ties {sameNameContacts.length === 1 ? 'this contact' : 'these contacts'} to the person checked. They may be someone else.</p>
            <ul className="divide-y divide-line">{sameNameContacts.map((p) => <Person key={`${p.name}|${p.company}`} p={p} />)}</ul>
          </div>
        )}
      </Section>

      <Section
        title="People you know around them"
        count={counts.people || 0}
        open={(counts.people || 0) > 0}
        note={<p className="muted mb-3 text-xs">Your contacts at the companies this check ties to {person}, and contacts named in the check. Your own connections first, then senior titles. Company names come from your import, so check that each person overlapped with them.</p>}
      >
        {groups.length === 0
          ? <p className="text-sm text-slate-700">None of your contacts work at {network.companiesChecked?.length ? network.companiesChecked.slice(0, 6).join(', ') : 'a company tied to them'}{network.investorsChecked?.length ? ' or at their investors' : ''}.</p>
          : <div className="space-y-5">{groups.map((g) => <Group key={g.key} g={g} />)}</div>}
        {notes.map((n) => <p key={n} className="mt-3 text-xs text-muted">{n}</p>)}
      </Section>

      {references.length > 0 && (
        <Section
          title="Who to call for a reference"
          count={references.length}
          open
          note={<p className="muted mb-3 text-xs">Former colleagues first, then people named beside them and their investors. Someone who may report to them today is not suggested.</p>}
        >
          <ol className="divide-y divide-line">
            {references.map((p) => (
              <Person key={`${p.name}|${p.company}`} p={p}>
                <p className="mt-1 text-sm text-ink">{p.ask}</p>
              </Person>
            ))}
          </ol>
        </Section>
      )}
    </>
  );
}
