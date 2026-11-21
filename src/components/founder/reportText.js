/**
 * A deep report as plain text, for "Copy as text": something an investor can
 * paste into a memo. It carries the same caveats as the page: what did not
 * answer, and that leads are questions, not facts.
 */
import { summaryChips, screenCounts, formatWhen, savedReport } from './summary';
import { yearsOf } from './resumeText';
import { safeHref } from '../../server/founder/guardrails';

const cites = (ns) => (Array.isArray(ns) && ns.length ? ` [${ns.join(', ')}]` : '');
/** Model text and markdown to plain lines: citations as [n], no markup. */
function plain(text) {
  return String(text || '')
    .replace(/\[Source (\d+)\]/g, '[$1]')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

export function reportAsText(saved) {
  if (!saved) return '';
  const report = savedReport(saved); // a report saved before a field was added has gaps
  const out = [];
  const line = (s = '') => out.push(s);
  const p = report.profile || {};
  line(`Founder check: ${report.name}${report.company ? ` (${report.company})` : ''}`);
  if (report.generatedAt) line(`Report from ${formatWhen(report.generatedAt)}`);
  if (p.headline) line(`${p.headline}${p.basedIn?.text ? `, based in ${p.basedIn.text}` : ''}`);
  line(summaryChips(report).map((c) => c.text).join(' · '));
  const note = report.identityNote || report.identity?.note;
  if (note) line(`Note: ${note}`);
  line();
  if (report.brief) { line('BRIEF'); line(plain(report.brief)); line(); }

  const flagLine = (f) => line(`- [${f.n}] ${f.title}${f.date ? ` (${f.date})` : ''}${f.outcome?.text ? `. Outcome: ${f.outcome.text}` : ''}`);
  const held = report.ifRightPerson;
  line('RED FLAGS');
  if (!report.redFlags.length) {
    line(held.length
      ? `None tied to this person by anything typed; ${held.length} serious matter${held.length === 1 ? '' : 's'} below hold${held.length === 1 ? 's' : ''} if this is the right person.`
      : 'None tied to this person in the sources that answered. That is not proof of a clean record.');
  }
  report.redFlags.forEach(flagLine);
  if (held.length) {
    // tied only through a company the check assumed: as serious as a red flag once the identity is settled
    line(); line(`IF THIS IS THE RIGHT PERSON (tied only through ${report.assumedCompany || 'a company the check assumed'}; confirm who they are first)`);
    held.forEach(flagLine);
  }
  if (report.companyMatters?.length) {
    line(); line('ABOUT THEIR COMPANIES (records that do not name them)');
    for (const f of report.companyMatters) line(`- [${f.n}] ${f.title}${f.date ? ` (${f.date})` : ''}`);
  }
  line();

  const roles = p.roles || [];
  if (roles.length || p.education?.length || p.founded?.length) {
    line('PROFILE');
    for (const r of roles) line(`- ${[r.org, r.title].filter(Boolean).join(', ')}${yearsOf(r) ? ` (${yearsOf(r)})` : ''}${cites(r.cites)}`);
    // "left without a degree" is part of the line: a school alone would read as a degree earned
    for (const e of p.education || []) { const d = [e.degree, e.field, e.note].filter(Boolean); line(`- ${e.school}${d.length ? `, ${d.join(', ')}` : ''}${yearsOf(e) ? ` (${yearsOf(e)})` : ''}${cites(e.cites)}`); }
    for (const f of p.founded || []) line(`- Founded ${f.org}${f.year ? ` (${f.year})` : ''}${f.program ? `, ${f.program}` : ''}${f.outcome ? `, ${f.outcome}` : ''}${cites(f.cites)}`);
    for (const b of p.boards || []) line(`- Board: ${b.org}${b.role ? `, ${b.role}` : ''}${cites(b.cites)}`);
    if (p.leads?.length) {
      line('To confirm with the person (not facts):');
      for (const l of p.leads) line(`- ${l.text}${l.why ? `: ${l.why}` : ''}${cites(l.cites)}`);
    }
    line();
  }

  const c = screenCounts(report.screens);
  if (c.listed) {
    line(`PUBLIC-RECORD SCREENS: ${c.answered} of ${c.asked} answered in full`);
    for (const g of report.screens || []) {
      const silent = (g.items || []).filter((s) => s.status === 'failed' || s.status === 'not-run' || s.status === 'partial' || s.incomplete);
      if (silent.length) line(`- ${g.group}: did not answer in full: ${silent.map((s) => s.label).join('; ')}`);
    }
    line();
  }

  if (!report.coverageListed) { line('This saved report does not list which sources answered.'); line(); }
  const notSearched = (report.coverage?.notSearched || []).filter((s) => !s.off);
  if (notSearched.length) {
    line('DID NOT ANSWER');
    for (const s of notSearched) line(`- ${s.label}: ${s.reason}`);
    line();
  }
  if (report.coverage?.givenCompanies?.length) {
    line('EARLIER COMPANIES YOU GAVE');
    for (const c of report.coverage.givenCompanies) line(`- ${c.name}: ${c.screened ? 'screened' : 'checked only for ties to the person'}`);
    line();
  }
  if (report.coverage?.notCovered?.length) {
    line('NOT COVERED BY THE SOURCES THIS CHECK USES');
    for (const s of report.coverage.notCovered) line(`- ${s}`);
    line();
  }

  const numbered = new Map();
  for (const s of report.sections || []) for (const f of s.items || []) if (f.match !== 'possible' && !numbered.has(f.n)) numbered.set(f.n, f);
  if (numbered.size) {
    line('RECORDS TIED TO THE PERSON OR THEIR COMPANY');
    for (const f of [...numbered.values()].sort((a, b) => a.n - b.n)) line(`[${f.n}] ${f.title} · ${f.sourceLabel || ''}${f.date ? ` · ${f.date}` : ''}${safeHref(f.url) ? ` · ${safeHref(f.url)}` : ''}`);
    line();
  }
  if (report.notice) line(report.notice);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
