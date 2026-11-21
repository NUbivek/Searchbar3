/**
 * What the one-screen summary at the top of a deep report may claim, worked
 * out from the report alone so the page never says more than the check did.
 *
 * The rule that matters most: "0 red flags" is green only when every court,
 * regulator and watchlist screen answered in full. A screen that failed, was
 * not reached, or answered only in part leaves the count amber, and the chip
 * says how many did not answer. No record found is never a clean record.
 */

/** Screen groups whose silence would make "no red flag" misleading. */
const FLAG_GROUP = /sanction|watchlist|court|prosecut|regulat/i;
const ANSWERED = new Set(['clear', 'records', 'name-only']);

/** A screen that answered every lookup in full. */
export const answeredInFull = (s) => ANSWERED.has(s?.status) && !s?.incomplete;

/**
 * Counts over the report's public-record screens. Screens not enabled on this deployment are not counted
 * as asked. -> { asked, answered, flagAsked, flagUnanswered, listed }
 */
export function screenCounts(screens) {
  const out = { asked: 0, answered: 0, flagAsked: 0, flagUnanswered: 0, listed: Array.isArray(screens) };
  for (const g of Array.isArray(screens) ? screens : []) {
    const flag = FLAG_GROUP.test(String(g?.group || ''));
    for (const s of Array.isArray(g?.items) ? g.items : []) {
      if (!s || s.status === 'off') continue;
      out.asked += 1;
      const ok = answeredInFull(s);
      if (ok) out.answered += 1;
      if (flag) {
        out.flagAsked += 1;
        if (!ok) out.flagUnanswered += 1;
      }
    }
  }
  return out;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Serious records tied only through a company the check assumed: they hold if this is the right person. */
export function ifRightCount(report) {
  const listed = Array.isArray(report?.ifRightPerson) ? report.ifRightPerson.length : 0;
  return Math.max(Number(report?.totals?.ifRightPerson) || 0, listed);
}

/**
 * The red-flag count as a chip: { text, tone, title }. Serious records held "if this is the right person"
 * are said in the chip and keep it amber: a zero there is not a clean result, it is an unsettled identity.
 */
export function redFlagChip(report) {
  const chip = flagChipAlone(report);
  const held = ifRightCount(report);
  if (!held) return chip;
  return {
    text: `${chip.text} · ${held} serious if right person`,
    tone: chip.tone === 'chip chip-bad' ? chip.tone : 'chip chip-warn',
    title: `${plural(held, 'serious matter')} ${held === 1 ? 'is' : 'are'} tied to this person only through a company the check assumed; ${held === 1 ? 'it holds' : 'they hold'} if this is the right person.${chip.title ? ` ${chip.title}` : ''}`,
  };
}

function flagChipAlone(report) {
  const n = Number(report?.totals?.redFlags ?? report?.redFlags?.length ?? 0) || 0;
  if (n > 0) {
    const serious = report?.totals?.seriousRecords;
    return { text: plural(n, 'red flag'), tone: 'chip chip-bad', title: serious ? `${serious} serious records, grouped by matter` : undefined };
  }
  const c = screenCounts(report?.screens);
  if (!c.listed) return { text: '0 red flags', tone: 'chip chip-warn', title: 'This saved report does not list which court, regulator and watchlist screens answered.' };
  if (!c.flagAsked) return { text: '0 red flags · no court or watchlist screen ran', tone: 'chip chip-warn', title: 'No court, regulator or watchlist source was asked, so nothing was screened.' };
  if (c.flagUnanswered) {
    return {
      text: `0 red flags · ${plural(c.flagUnanswered, 'screen')} did not answer`,
      tone: 'chip chip-warn',
      title: `${c.flagUnanswered} of ${c.flagAsked} court, regulator and watchlist screens did not answer in full, so a record there may have been missed.`,
    };
  }
  if (report?.totals?.companyUnconfirmed || report?.identityNote) {
    return { text: '0 red flags', tone: 'chip', title: 'No record ties this person to the company given, so the screens may have looked at the wrong person or missed records under another name.' };
  }
  return { text: '0 red flags', tone: 'chip chip-good', title: `All ${c.flagAsked} court, regulator and watchlist screens answered in full. That is not proof of a clean record.` };
}

/** Every chip of the summary, in order: [{ key, text, tone, title? }]. */
export function summaryChips(report) {
  const t = report?.totals || {};
  const chips = [{ key: 'flags', ...redFlagChip(report) }];
  const matters = Number(t.companyMatters ?? report?.companyMatters?.length ?? 0) || 0;
  chips.push({ key: 'company', text: plural(matters, 'company matter'), tone: matters ? 'chip chip-warn' : 'chip', title: 'Serious records about a company they founded or run that do not name them.' });
  const tied = (Number(t.confirmed) || 0) + (Number(t.likely) || 0);
  chips.push({ key: 'tied', text: `${plural(tied, 'record')} tied to the person`, tone: 'chip', title: `${t.records ?? tied} records in all` });
  if (t.possible > 0) chips.push({ key: 'possible', text: `${t.possible} name match only`, tone: 'chip chip-warn', title: 'Records that share the name and nothing else. Kept apart, below.' });
  const c = screenCounts(report?.screens);
  if (c.listed && c.asked) {
    chips.push({ key: 'screens', text: `${c.answered} of ${c.asked} screens answered`, tone: c.answered === c.asked ? 'chip' : 'chip chip-warn', title: 'Public-record screens that answered every lookup in full, out of those asked.' });
  }
  return chips;
}

const LISTS = ['sections', 'redFlags', 'ifRightPerson', 'companyMatters', 'possibleNamesake', 'claimChanges', 'relatedParties', 'timeline', 'ownStatements'];
/**
 * A report as the page draws it. A check saved before a field was added (checks are kept three days) lacks
 * it: every list is filled in as empty, so the page does not break. Coverage is left missing when it is
 * missing (`coverageListed` false), so the page says the saved report does not list what answered instead of
 * claiming that nothing answered or that everything did.
 */
export function savedReport(report) {
  if (!report || typeof report !== 'object') return report;
  const out = { ...report };
  for (const k of LISTS) if (!Array.isArray(out[k])) out[k] = [];
  out.sections = out.sections.filter((s) => s && typeof s === 'object').map((s) => ({ ...s, items: Array.isArray(s.items) ? s.items : [] }));
  const c = report.coverage;
  out.coverageListed = Boolean(c && typeof c === 'object' && Array.isArray(c.searched));
  if (out.coverageListed) {
    out.coverage = { ...c, notSearched: Array.isArray(c.notSearched) ? c.notSearched : [], notCovered: Array.isArray(c.notCovered) ? c.notCovered : [], partlyAnswered: Array.isArray(c.partlyAnswered) ? c.partlyAnswered : [] };
  } else {
    out.coverage = null;
  }
  if (Array.isArray(out.screens)) out.screens = out.screens.filter((g) => g && typeof g === 'object').map((g) => ({ ...g, items: Array.isArray(g.items) ? g.items : [] }));
  return out;
}

/** Records of a report by citation number, from every list that carries them. */
export function recordsByNumber(report) {
  const map = new Map();
  const add = (f) => { if (f && Number.isFinite(f.n) && !map.has(f.n)) map.set(f.n, f); };
  for (const s of report?.sections || []) for (const f of s.items || []) add(f);
  for (const k of ['redFlags', 'ifRightPerson', 'companyMatters', 'possibleNamesake', 'claimChanges']) for (const f of report?.[k] || []) add(f);
  return map;
}

const recordKey = (f) => String(f?.id || f?.url || `${f?.title}|${f?.sourceLabel}`);

/**
 * What a new run found that the previous one did not, by record id (or link). -> { fresh: Set<key>, gone: [record] }
 * Only records tied to the person or their company count as gone; a name-only match dropping out is not news.
 */
export function compareReports(before, after) {
  const all = (r) => [...recordsByNumber(r).values()];
  const old = new Set(all(before).map(recordKey));
  const now = new Set(all(after).map(recordKey));
  const fresh = new Set(all(after).map(recordKey).filter((k) => !old.has(k)));
  const gone = all(before).filter((f) => f.match !== 'possible' && !now.has(recordKey(f)));
  return { fresh, gone };
}
export { recordKey };

/** "18 Nov 2026, 14:05" for a report's date, or ''. */
export function formatWhen(iso) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
