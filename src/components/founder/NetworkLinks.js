/**
 * "Your network" on a deep check report: whether the person is one of the
 * user's own contacts, who the user knows around them (grouped and ranked),
 * and the five best people to call for a reference. The data comes with the
 * report (report.network, built by server/founder/networkLink.js) and is the
 * signed-in user's own; it is never shown to anyone else.
 *
 * Same markup and classes as the report's other sections (parts.js Block).
 * A lookup that did not finish is said as such (network.failed), never shown
 * as "none of your contacts".
 */
import React, { useState } from 'react';
import Link from 'next/link';
import { HiOutlineArrowTopRightOnSquare } from 'react-icons/hi2';
import { Block, ExternalLink, usePrinting } from './parts';

// Same card as the report's other sections (parts.js Block): prints open, heading outside the toggle.
const Section = Block;

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
        <ExternalLink href={p.profileUrl} className="font-medium text-ink hover:text-brand-600 hover:underline">
          {p.name}{p.profileUrl ? <> <HiOutlineArrowTopRightOnSquare className="founder-no-print inline align-text-top text-muted" style={{ width: 12, height: 12 }} /></> : null}
        </ExternalLink>
        <Relationship p={p} />
        {since && <span className="text-xs text-muted">connected {since}</span>}
      </div>
      {(p.position || p.company) && <p className="text-slate-700">{[p.position, p.company].filter(Boolean).join(' · ')}{p.years ? <span className="text-xs text-muted"> · {p.years}</span> : null}</p>}
      {p.why && <p className="text-xs text-muted">{p.why}</p>}
      {p.reason && <p className="text-xs text-muted">{p.reason}</p>}
      {children}
    </li>
  );
}

function Group({ g }) {
  const printing = usePrinting();
  const [all, setAll] = useState(false);
  const first = 6;
  const shown = all || printing ? g.people : g.people.slice(0, first);
  return (
    <div>
      <p className="eyebrow mb-1.5">
        {g.title} · {g.total}{g.total > g.people.length ? ` (showing the top ${g.people.length})` : ''}
      </p>
      {g.companies?.length > 0 && <p className="mb-1.5 text-xs text-muted">{g.companies.join(', ')}</p>}
      <ul className="divide-y divide-line">{shown.map((p) => <Person key={`${p.name}|${p.company}`} p={p} />)}</ul>
      {g.more > 0 && <p className="mt-1.5 text-xs text-muted">{g.more} more not listed; the most senior are shown first.</p>}
      {g.people.length > first && !printing && (
        <button type="button" className="founder-no-print btn-ghost mt-2 px-2 py-1 text-xs" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? 'Show fewer' : `Show all ${g.people.length}`}
        </button>
      )}
    </div>
  );
}

const importLink = <Link href="/network" className="font-medium text-brand-600 hover:underline">Network Map</Link>;

export default function NetworkLinks({ network, name, company = '' }) {
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
  const failed = network.failed || {};
  const person = name || 'this person';
  // "None of your contacts work at…" only when the lookups it rests on all answered
  const noneText = failed.companies
    ? 'People you know at their companies could not be read just now. Open the report again in a moment.'
    : `None of your contacts work at ${network.companiesChecked?.length ? network.companiesChecked.slice(0, 6).join(', ') : 'a company tied to them'}${network.investorsChecked?.length && !failed.investors ? ' or at their investors' : ''}.`;
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
            No company was entered, so this check used {network.seededCompany}, the company of the one contact in your network named {person}, which you confirmed.
          </p>
        )}
        {self ? (
          <ul><Person p={{ ...self, why: self.note }} /></ul>
        ) : failed.self ? (
          <p className="text-sm text-slate-700">Whether {person} is one of your contacts could not be read just now.</p>
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
          ? <p className="text-sm text-slate-700">{noneText}</p>
          : <div className="space-y-5">{groups.map((g) => <Group key={g.key} g={g} />)}</div>}
        {notes.filter((n) => !(failed.companies && groups.length === 0 && n === noneText)).map((n) => <p key={n} className="mt-3 text-xs text-muted">{n}</p>)}
        {String(company || '').trim() && (
          <p className="founder-no-print mt-3 text-xs">
            <Link href={`/network?${new URLSearchParams({ ask: `Who do I know at ${String(company).trim()}?` })}`} className="font-medium text-brand-600 hover:underline">
              Ask your network about {String(company).trim()}
            </Link>
          </p>
        )}
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
