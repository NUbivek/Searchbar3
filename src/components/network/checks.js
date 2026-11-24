/**
 * Founder checks the user has already run, matched to their contacts. A
 * contact with a finished check gets a "Checked" chip that reopens it; one
 * still running gets "Running". Moved out of pages/network.js so the people
 * panel can use the same mark; the page re-exports the helpers.
 */
import React from 'react';
import Link from 'next/link';
import { normalizeCompanyKey, companyMatch, companyFormMatch } from '../../utils/network/parseContacts';

/** 'YYYY-MM-DD' or an ISO time as "Nov 21, 2026"; '' when unreadable. */
export const formatDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', ...(iso.length === 10 ? { timeZone: 'UTC' } : {}) });
};

/** { checks, running, nameCounts } for the page, read by CheckMark. */
export const ChecksContext = React.createContext(null);

// Titles before a name and degrees after it are not part of it: "Dr. Jane Roe, PhD" is "jane roe". "Jr" and "Sr"
// stay, since they tell a father from a son.
const HONORIFIC = /^(?:dr|mr|mrs|ms|mx|miss|prof|professor|sir|dame)\s+/;
const DEGREES = new Set(['phd', 'mba', 'md', 'jd', 'cfa', 'cpa', 'pe', 'esq', 'msc', 'ma', 'bsc', 'ba', 'bs', 'ms', 'mph', 'dds', 'rn', 'pmp']);
const checkNameKey = (name) => {
  let key = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\([^)]*\)/g, ' ').split(',')[0].replace(/['’`.]/g, '').replace(/[^a-z0-9\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (let prev = ''; prev !== key;) { prev = key; key = key.replace(HONORIFIC, ''); }
  const words = key.split(' ');
  while (words.length > 2 && DEGREES.has(words[words.length - 1])) words.pop();
  return words.join(' ');
};
/** The same company written two ways: equal, a longer name containing a two-word one, or only form words added. */
const sameCompany = (a, b) => {
  const x = normalizeCompanyKey(a);
  const y = normalizeCompanyKey(b);
  return Boolean(x && y) && Boolean(companyMatch(x, y) || companyFormMatch(x, y));
};
/**
 * The finished check for this contact: same full name, and the same company
 * when the check had one. A check run without a company is only tied to a
 * contact when no other loaded contact carries that full name (nameCounts:
 * name key -> how many loaded contacts carry it); otherwise it may be about
 * a namesake, and nothing is shown.
 */
export function findCheck(checks, name, company, nameCounts) {
  const key = checkNameKey(name);
  if (!key || !Array.isArray(checks)) return null;
  const sameName = checks.filter((c) => checkNameKey(c.name) === key);
  const withCompany = sameName.find((c) => String(company || '').trim() && String(c.company || '').trim() && sameCompany(c.company, company));
  if (withCompany) return withCompany;
  const unique = nameCounts && typeof nameCounts.get === 'function' && nameCounts.get(key) === 1;
  return unique ? (sameName.find((c) => !String(c.company || '').trim()) || null) : null;
}
/** name key -> how many of these contacts carry that full name. */
export function contactNameCounts(contacts) {
  const counts = new Map();
  for (const c of Array.isArray(contacts) ? contacts : []) {
    const key = checkNameKey(c?.name);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
/**
 * The finished check itself (?job=), so the Founder Check page reopens it instead of starting a new one; the
 * name and company stay in the link for a check the server no longer keeps. A check anchored on a company it
 * was given (seededCompany) keeps that company.
 */
export const checkHref = (c) => {
  const q = new URLSearchParams({ name: String(c.name || '') });
  const company = c.company || c.seededCompany;
  if (company) q.set('company', String(company));
  if (c.id) q.set('job', String(c.id));
  return `/founder?${q}`;
};
/**
 * The "Checked" chip for a finished check: { className, text, title }. Never green: the list does not say
 * whether every court and watchlist screen answered, so 0 red flags is not a clean result. Serious records
 * held "if this is the right person" (the check assumed the company) make it amber and are said.
 */
export function checkChip(check) {
  const flags = Number(check?.redFlags) || 0;
  const held = Number(check?.ifRightPerson) || 0;
  return {
    className: flags ? 'chip chip-bad' : held > 0 ? 'chip chip-warn' : 'chip',
    text: `Checked${flags ? ` · ${flags} red flag${flags === 1 ? '' : 's'}` : ''}${held > 0 ? ` · ${held} serious if right person` : ''}`,
    title: `Founder check finished ${formatDate(check?.date)}. Open the report to see which screens answered.${held > 0 ? ` ${held} serious matter${held === 1 ? ' holds' : 's hold'} if this is the right person.` : ''}`,
  };
}
/** The "Checked" (or "Running") chip for one contact, or nothing. */
export function CheckMark({ name, company }) {
  const ctx = React.useContext(ChecksContext);
  const check = findCheck(ctx?.checks, name, company, ctx?.nameCounts);
  if (!check) {
    // A check still running is shown as running, so opening it picks it up instead of starting another.
    const running = findCheck(ctx?.running, name, company, ctx?.nameCounts);
    return running ? <Link href={checkHref(running)} className="chip" title="A founder check of this person is still running. Open it to follow it.">Running</Link> : null;
  }
  const chip = checkChip(check);
  return <Link href={checkHref(check)} className={chip.className} title={chip.title}>{chip.text}</Link>;
}
