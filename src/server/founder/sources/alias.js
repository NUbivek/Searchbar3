/**
 * Another name of the person being checked: a thread of kind 'alias' (a former or maiden name, a birth name, an
 * anglicised name, the name in another script).
 *
 * Watchlist, court and enforcement sources screen such a name exactly as they screen the person's own name, so
 * a sanctions listing or a conviction under a maiden name is not missed. How far the result may be trusted
 * depends on where the name came from:
 *   - a name the user typed is the person's by the user's word: a record under it grades like the main name;
 *   - a name read out of a record ("née Smith", "also known as") came from a source, not from the user: a
 *     record under it is 'likely' at most, held so a later re-grade cannot raise it, and the threads such a
 *     lookup finds are noted but not followed (a second-hand name must not spread through the check).
 *
 * A source opts in by listing 'alias' in its kinds and wrapping its run with withAliasHold: the source then sees
 * an ordinary lookup about the person, under the other name, and needs no code of its own for it.
 *
 * Not a source itself (index.js only lists objects with an id, kinds and run).
 */
import { matchRank } from '../identity';
import { nameMatcher } from '../../founderCheck';
import { personNameVariants, isCommonName } from '../names';

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** True for a lookup about another name of the person. */
export const isAliasTask = (task) => task?.kind === 'alias';

/** True for a lookup (or a thread) about the person: their own name or another name of theirs. */
export const isSelfTask = (task) => task?.kind === 'subject' || task?.kind === 'alias';

/**
 * True when the user typed this name for the person. identity.createSubject puts typed other names into
 * subject.hasName (and nothing found later), so the matcher itself says which kind the name is.
 */
export function isTypedAlias(subject, name) {
  const n = oneLine(name);
  if (!n || typeof subject?.hasName !== 'function') return false;
  return Boolean(subject.hasName(n));
}

/** The reason shown beside a record found only under a name read from a record. */
export const aliasReason = (name) => `names the person as ${oneLine(name)}, another name found in a linked record`;

/**
 * The subject as a source should see it for a lookup under another name: the same anchors (companies, schools,
 * associates: the very same maps, so anything a source learns is kept), with the other name as the name to
 * search and to read. The person's own name still counts when a record gives both.
 */
export function aliasView(subject, name) {
  const n = oneLine(name);
  const variants = personNameVariants(n);
  const own = Array.isArray(subject?.hasName?.variants) && subject.hasName.variants.length ? subject.hasName.variants : (subject?.variants || []);
  return {
    ...subject,
    name: n,
    variants,
    searchNames: [...new Set([...variants, ...(subject?.searchNames || [])])],
    hasName: nameMatcher([...variants, ...own]),
    // A name is as common as the commoner of the two: "Jane Smith" as a maiden name needs the same care
    common: Boolean(subject?.common) || isCommonName(n),
    mononym: false,
    otherNames: subject?.otherNames || [],
    lookupName: n,
  };
}

/**
 * Hold a finding from an alias lookup to what that name allows. A typed name changes nothing. A found name
 * lowers 'confirmed' to 'likely', fixes the grade, and says why. A finding from any other lookup, or a null,
 * is returned unchanged.
 * @param {object} task the lookup ({ kind, value })
 * @param {object} subject from identity.createSubject (the real one, not aliasView)
 * @param {object|null} finding from makeFinding
 */
export function holdAliasGrade(task, subject, finding) {
  if (!finding || !isAliasTask(task) || isTypedAlias(subject, task.value)) return finding;
  const reason = aliasReason(task.value);
  const data = { ...(finding.data || {}), otherName: oneLine(task.value) };
  if (matchRank(finding.match) > matchRank('likely')) {
    const reasons = [reason, ...(finding.matchReasons || []).filter((r) => r !== reason)].slice(0, 4);
    return { ...finding, match: 'likely', matchFixed: true, matchReasons: reasons, data };
  }
  if (finding.match === 'likely') {
    const reasons = [reason, ...(finding.matchReasons || []).filter((r) => r !== reason)].slice(0, 4);
    return { ...finding, matchFixed: true, matchReasons: reasons, data };
  }
  return { ...finding, data };
}

/** holdAliasGrade over a list (nulls dropped). */
export const holdAliasGrades = (task, subject, findings) => (findings || []).map((f) => holdAliasGrade(task, subject, f)).filter(Boolean);

/**
 * Wrap a source's run so it takes 'alias' lookups. The source is asked as for the person (kind 'subject'),
 * under the other name (aliasView); its findings are then held by holdAliasGrade against the real subject.
 * Every other lookup goes through unchanged. Safe to apply twice.
 */
export function withAliasHold(run) {
  if (typeof run !== 'function' || run.aliasHold) return run;
  const wrapped = async function runWithAliasHold(task, ctx) {
    if (!isAliasTask(task)) return run.call(this, task, ctx);
    const name = oneLine(task.value);
    const subject = ctx?.subject;
    const out = await run.call(this, { ...task, kind: 'subject', value: name, alias: name }, { ...ctx, subject: aliasView(subject, name) });
    if (!out) return out;
    const typed = isTypedAlias(subject, name);
    return {
      ...out,
      findings: holdAliasGrades(task, subject, out.findings),
      // A found name's lookup may point somewhere, but is not trusted enough to be followed on its own
      ...(Array.isArray(out.threads) && !typed ? { threads: out.threads.map((t) => (t && t.trusted ? { ...t, trusted: false } : t)) } : {}),
    };
  };
  wrapped.aliasHold = true;
  return wrapped;
}
