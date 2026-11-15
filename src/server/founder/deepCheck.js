/**
 * The deep background check: a loop that keeps pulling threads.
 *
 *   step 0   every source is asked about the person (and their company)
 *   then     each record is graded for identity, cleaned by the privacy
 *            rules and read for new threads: a former company, a school, a
 *            co-founder, a relative in a public role, a handle, a domain, an
 *            old profile page
 *   next     every new thread is pulled in turn, by the sources that can
 *            handle that kind of thread, and what they return is read for
 *            more threads
 *   stop     when a round finds nothing new, or the budget is spent
 *
 * It learns as it goes. Within a check, a company confirmed in one round
 * upgrades the records that mention it in the next (identity.js), and when
 * the loop runs dry a second reader (gaps.js) goes over the records for
 * threads the first pass missed. Across checks, each query pattern and
 * source is scored by whether it produced evidence, and the best-scoring
 * ones run first (learning.js).
 *
 * The whole state is plain JSON, so a check can run one request at a time
 * (jobStore.js): start() -> step() ... step() until phase is 'report'.
 * No network here: sources are passed in, which is also how tests run it.
 */
import { createSubject, restoreSubject, exportAnchors, addAnchor, matchSubject, matchRank, personKey } from './identity';
import { connectorResult, THREAD_KINDS } from './finding';
import { companyKeys } from '../founderCheck';
import { loadStats, recordStats, rankByLearning } from '../learning';

export const LIMITS = {
  maxTasks: 420, // lookups per check, across all sources (a few minutes of work)
  maxDepth: 2, // the person is depth 0; what is found about them is 1; what those lead to is 2
  maxFindings: 700,
  maxPerSource: 90,
  maxSteps: 18,
  dryStepsToStop: 2,
  maxReviews: 2, // how many times the second reader may restart a loop that ran dry
  stepMs: 40000,
  concurrency: 8,
  taskTimeoutMs: 20000,
  restMs: 20000, // how long a lookup waits when its host is resting
  maxRests: 4, // how many times one lookup may be put back for a resting host
  // how many threads of each kind are pulled; the rest are listed, not followed
  pull: { company: 10, affiliate: 16, school: 6, associate: 10, relative: 8, handle: 6, domain: 6, url: 10 },
};

export const GAP_TEMPLATE = 'q.gap';
const KIND_WEIGHT = { subject: 1, url: 0.85, company: 0.8, relative: 0.72, associate: 0.62, school: 0.58, handle: 0.5, domain: 0.45 };
const DEPTH_WEIGHT = [1, 0.8, 0.55];
const ANCHOR_KIND = { company: 'companies', school: 'schools', associate: 'people', handle: 'handles', domain: 'domains' };

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// "Theranos" and "Theranos, Inc." are one company
const threadKey = (t) => `${t.kind}|${t.kind === 'company' ? (companyKeys(t.value)[0] || norm(t.value)) : t.kind === 'associate' || t.kind === 'relative' ? personKey(t.value) : norm(t.value)}`;

// Headlines are a poor place to read company names from: "Ousted Theranos", "Why Theranos", "SEC Charges
// Theranos" and "U.S" are not companies, and each one followed costs dozens of lookups.
const HEADLINE_LEAD = /^(why|how|what|when|where|who|inside|ousted|disgraced|former|ex|demise|rise|fall|collapse|conversation|interview|meet|watch|read|sec|doj|fbi|feds|exclusive|opinion|is|was|did|does|will|can|boyfriend|girlfriend|husband|wife|fianc[ée]e?|father|mother|brother|sister|son|daughter|ceo|judge|attorney|lawyer|prosecutors?|defendant|billionaire|convicted|jailed|fraudster)\b/i;
const NOT_AN_ORGANISATION = /^(us|usa|uk|eu|un|united states|united kingdom|america|europe|government|congress|senate|police|court|state|city|county|inc|llc|ltd|company|the company|startup)$/i;
const containsWords = (longer, shorter) => longer !== shorter && ` ${longer} `.includes(` ${shorter} `);

/**
 * Is this organisation thread worth recording? Returns:
 *   'junk'      not an organisation name at all
 *   an existing thread   it is a longer or shorter way of naming one already recorded
 *   null        a new organisation
 */
function sameOrganisation(state, thread) {
  const raw = String(thread.value || '').replace(/\./g, '').trim();
  if (raw.length < 3 || NOT_AN_ORGANISATION.test(raw)) return 'junk';
  // "Ousted Theranos", and equally a lone "Disgraced" or "Convicted" lifted from a headline
  if (thread.kind === 'company' && HEADLINE_LEAD.test(raw) && (/\s/.test(raw) || HEADLINE_LEAD.exec(raw)[0].length === raw.length)) return 'junk';
  const key = threadKey(thread).slice(thread.kind.length + 1);
  if (!key) return 'junk';
  for (const [otherKey, other] of Object.entries(state.threads)) {
    if (other.kind !== thread.kind) continue;
    const k = otherKey.slice(other.kind.length + 1);
    // "Conversation With Theranos" is Theranos; "The School of Engineering at Stanford University" is Stanford University
    // A longer trusted name is never folded into a shorter untrusted one: a trusted "Meta Materials" must not
    // turn a namesake's "Meta" into an anchor. It is recorded as its own organisation instead.
    if (k.length >= 4 && containsWords(key, k) && (other.trusted || !thread.trusted)) return other;
    if (k.length >= 4 && other.trusted && containsWords(k, key) && key.length >= 4) return other;
  }
  return null;
}
// A free-form search (proposed by the second reader) is told apart by its wording
// The same page reported twice is one record; a register page that lists several records is several.
const headline = (title) => norm(title).replace(/\s+[-|–—]\s+[^-|–—]{2,40}$/, '').slice(0, 70);
const pageKey = (f) => `${f.category}|${urlKey(f.url)}|${headline(f.title)}`;
const taskKey = (t) => `${t.connector}|${t.kind}|${t.kind === 'company' ? (companyKeys(t.value)[0] || norm(t.value)) : norm(t.value)}|${t.template || ''}${t.template === GAP_TEMPLATE ? `|${norm(t.params?.query)}` : ''}`;
const learnKey = (t) => `${t.connector}${t.template ? `:${t.template}` : ''}`;
// Two records are the same page when host, path, query and fragment agree. The query and fragment matter:
// a forum thread is "item?id=N", a register row is a query, and one long page can hold several records at
// different anchors. Only tracking parameters are ignored.
const TRACKING = /^(utm_\w+|ref|ref_src|fbclid|gclid|mc_cid|mc_eid|igshid|share|source|cmpid|ocid)$/i;
function urlKey(u) {
  try {
    const url = new URL(String(u || ''));
    const query = [...url.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}${query ? `?${query}` : ''}${url.hash || ''}`.toLowerCase();
  } catch {
    return String(u || '').toLowerCase();
  }
}

/**
 * What the person reading the report is told when a source failed: a plain reason, never the technical
 * message (status codes, library errors, or text echoed from the remote page). The raw message goes to
 * the server log only.
 */
export function plainFailure(message) {
  const m = String(message || '');
  if (/timed out|out of time/i.test(m)) return 'did not respond in time';
  if (/rate limited|\b429\b|slower requests/i.test(m)) return 'was busy and turned the request away';
  if (/not json|larger than/i.test(m)) return 'returned something that could not be read';
  return 'could not be reached';
}
// The host is resting, or this lookup's turn at a paced host could not come before the deadline: not a failure.
const HOST_RESTING = /Out of time before the request could start|is being left alone/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), Math.max(500, ms)); }),
  ]).finally(() => clearTimeout(timer));
}

/** A new check. */
export function startState({ name, company = '' }) {
  const subject = createSubject({ name, company });
  return {
    version: 1,
    name: subject.name,
    company: subject.company,
    anchors: exportAnchors(subject),
    identity: { status: subject.company ? 'given' : 'open', note: null },
    phase: 'collect',
    step: 0,
    startedAt: Date.now(),
    tasksRun: 0,
    drySteps: 0,
    reviews: 0,
    needsReview: false,
    queue: [],
    done: [],
    threads: {},
    findings: [],
    sources: {},
    log: [],
    dropped: { tasks: 0, findings: 0, threads: 0 },
  };
}

/**
 * How the person is tied to a company decides how hard the company is looked at.
 *   primary    they founded, own or run it (or it is the company the user gave): the company itself is
 *              checked in full, since its lawsuits, insolvency and breaches reflect on them
 *   affiliate  they sit on its board, invested in it, advised it or once worked there: only what ties the
 *              two together is looked up. A board seat at a large company must not fill the report with
 *              that company's litigation.
 */
const PRIMARY_TIE = /\b(found(?:ed|er|ing)|co-?found\w*|started|launched|ran|runs|led|heads|headed|chief executive|CEO|CTO|COO|CFO|owner|owns|president|managing (?:director|partner|member)|general partner|principal|executive officer|sole (?:director|member|shareholder)|proprietor|10% owner|holding vehicle|promoter|earlier name|formerly named|the company given|the company most sources name)\b/i;
export const tieOf = (thread) => (PRIMARY_TIE.test(`${thread.why || ''} ${thread.role || ''}`) ? 'primary' : 'affiliate');
/** Sources that establish what the person did at a company; the only ones asked about an affiliate. */
const AFFILIATE_SOURCES = new Set(['sec-company', 'uk-companies-house', 'fr-companies', 'yc-directory']);
export const JOINT_TEMPLATES = ['q.joint-role', 'q.joint-adverse'];

/** The tasks a thread turns into: one per source (and per query pattern) that can handle its kind. */
function planTasks(thread, depth, connectors, subject) {
  const out = [];
  const affiliate = thread.kind === 'company' && thread.tie === 'affiliate';
  if (affiliate) {
    // The person and the company together: what they did there, and anything adverse that names both.
    const searcher = connectors.find((c) => c.id === 'web-search' && (typeof c.enabled !== 'function' || c.enabled()));
    if (searcher) {
      const both = `"${subject.name}" "${thread.value}"`;
      out.push({ connector: searcher.id, kind: 'company', value: thread.value, depth, template: JOINT_TEMPLATES[0], params: { query: both }, prior: 0.5, why: thread.why || '', relation: null });
      out.push({ connector: searcher.id, kind: 'company', value: thread.value, depth, template: JOINT_TEMPLATES[1], params: { query: `${both} lawsuit OR sued OR fraud OR investigation OR dispute OR fired OR bankruptcy` }, prior: 0.55, why: thread.why || '', relation: null });
    }
  }
  for (const c of connectors) {
    if (!c.kinds.includes(thread.kind)) continue;
    if (affiliate && !AFFILIATE_SOURCES.has(c.id)) continue;
    if (typeof c.enabled === 'function' && !c.enabled()) continue;
    const variants = typeof c.plan === 'function' ? c.plan(thread, subject) : [{}];
    for (const v of variants || []) {
      out.push({
        connector: c.id, kind: thread.kind, value: thread.value, depth,
        template: v.template || null, params: v.params || null,
        prior: v.prior ?? c.prior ?? 0.5, why: v.why || thread.why || '', relation: thread.relation || null, platform: thread.platform || null,
      });
    }
  }
  return out;
}

function enqueue(state, tasks) {
  const seen = new Set([...state.done, ...state.queue.map(taskKey)]);
  let added = 0;
  for (const t of tasks) {
    const key = taskKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    state.queue.push(t);
    added += 1;
  }
  return added;
}

/**
 * Does this thread tell us anything about who the person is? A handle that is only the person's own name
 * run together ("johnsmith") carries no identity beyond the name: it is followed, never used to tie
 * records to them.
 */
function anchors(subject, thread) {
  if (!ANCHOR_KIND[thread.kind]) return false;
  if (thread.kind !== 'handle') return true;
  const flat = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const handle = flat(thread.value);
  return Boolean(handle) && !(subject.slugs || []).some((slug) => flat(slug) === handle);
}

/**
 * Record a thread. Returns it when it is new and should be pulled, else null.
 * A thread is only pulled, and only becomes an identity anchor, when it is
 * trusted: it came from a record already tied to the subject. A namesake's
 * employer must never become "known" about the subject.
 */
function noteThread(state, subject, thread, depth, evidence = null) {
  if (!thread || !THREAD_KINDS.includes(thread.kind)) return null;
  const key = threadKey(thread);
  let existing = state.threads[key];
  if (!existing && (thread.kind === 'company' || thread.kind === 'school')) {
    const same = sameOrganisation(state, thread);
    if (same === 'junk') return null;
    if (same) existing = same;
  }
  if (!existing && (thread.kind === 'associate' || thread.kind === 'relative')) {
    // someone already recorded as a relative is not recorded again as an associate (or the reverse)
    const other = state.threads[`${thread.kind === 'associate' ? 'relative' : 'associate'}|${personKey(thread.value)}`];
    if (other) existing = other;
  }
  if (existing) {
    existing.support = (existing.support || 1) + 1;
    addEvidence(existing, evidence);
    // first seen deep (from an untrusted record), now seen closer to the person: it is pulled at the shallower depth
    existing.depth = Math.min(existing.depth ?? depth, depth);
    // A later record may show the person founded or ran a company first seen as a mere affiliation
    const promoted = existing.kind === 'company' && existing.tie === 'affiliate' && thread.trusted && tieOf(thread) === 'primary';
    if (promoted) { existing.tie = 'primary'; existing.why = thread.why || existing.why; }
    if (thread.trusted && !existing.trusted) {
      existing.trusted = true;
      if (anchors(subject, thread)) addAnchor(subject, ANCHOR_KIND[thread.kind], thread.value, 'found');
      if (!existing.pulled) return existing;
    }
    if (promoted && existing.trusted) { existing.pulled = false; return existing; } // pull again, in full this time
    return null;
  }
  const record = { kind: thread.kind, value: thread.value, why: thread.why || '', depth, trusted: Boolean(thread.trusted), support: 1, pulled: false, ...(thread.kind === 'company' ? { tie: tieOf(thread) } : {}), ...(thread.relation ? { relation: thread.relation } : {}), ...(thread.role ? { role: thread.role } : {}), ...(thread.platform ? { platform: thread.platform } : {}) };
  addEvidence(record, evidence);
  state.threads[key] = record;
  if (record.trusted && anchors(subject, thread)) addAnchor(subject, ANCHOR_KIND[thread.kind], record.value, 'found');
  return record.trusted ? record : null;
}

/**
 * What a thread was seen in: one entry per distinct page (or, for a thread a source returned without a
 * record naming it, one per source and lookup subject). The same article returned by two query patterns
 * is one piece of evidence, however many times it is seen.
 */
function addEvidence(record, evidence) {
  if (!evidence?.length) return;
  const list = record.evidence || (record.evidence = []);
  for (const e of evidence) {
    if (list.length >= 12) break;
    if (!list.some((x) => x.key === e.key)) list.push(e);
  }
}

function evidenceFor(task, findings, thread) {
  const value = norm(thread?.value);
  const naming = value ? findings.filter((f) => norm(`${f.title} ${f.quote || ''} ${f.gradeText || ''}`).includes(value)) : [];
  if (!naming.length) return [{ key: `${task.connector}|${task.kind}|${norm(task.value)}`, by: task.connector, host: null }];
  return naming.map((f) => ({ key: pageKey(f), by: task.connector, host: urlKey(f.url).split(/[/?#]/)[0] || null }));
}

/** Pull a thread: mark it and queue its tasks, within the per-kind allowance. */
function pullThread(state, subject, record, connectors) {
  if (record.pulled) return 0;
  if (record.depth > LIMITS.maxDepth) { if (record.trusted) state.dropped.threads += 1; return 0; }
  // companies the person ran and companies they are merely tied to have separate allowances
  const pulledOfKind = Object.values(state.threads).filter((t) => t.kind === record.kind && t.pulled && (t.tie || '') === (record.tie || '')).length;
  const allowance = record.tie === 'affiliate' ? LIMITS.pull.affiliate : LIMITS.pull[record.kind];
  if (pulledOfKind >= (allowance ?? 6)) { state.dropped.threads += 1; return 0; }
  record.pulled = true;
  return enqueue(state, planTasks(record, record.depth, connectors, subject));
}

/**
 * When no company was given, records can only be matched by name. If one
 * company clearly dominates what the sources say about this name, adopt it
 * (and say so); otherwise leave the identity open and say that too.
 */
function resolveIdentity(state, subject, connectors) {
  if (state.identity.status !== 'open') return 0;
  // Only distinct evidence counts: one page seen twice (two query patterns returning the same article) is one.
  const weight = (t) => (t.evidence || []).length;
  const candidates = Object.values(state.threads).filter((t) => t.kind === 'company' && !t.trusted).sort((a, b) => weight(b) - weight(a) || (b.support || 0) - (a.support || 0));
  if (!candidates.length) return 0;
  const [top, second] = candidates;
  // and it must come from more than one place: two sources, or pages on two different sites
  const diverse = (t) => new Set((t.evidence || []).map((e) => e.by)).size >= 2 || new Set((t.evidence || []).map((e) => e.host).filter(Boolean)).size >= 2;
  if (weight(top) >= 2 && diverse(top) && (!second || weight(top) >= 2 * weight(second))) {
    top.trusted = true;
    top.tie = 'primary';
    addAnchor(subject, 'companies', top.value, 'inferred');
    state.identity = { status: 'inferred', note: `No company was given. Most sources about this name describe someone at ${top.value}, so the check follows that person. Add the company to be certain.` };
    state.log.push({ step: state.step, text: `Identity: following ${subject.name} at ${top.value} (the company most sources name).` });
    return pullThread(state, subject, top, connectors);
  }
  if (state.step >= 1) {
    state.identity = { status: 'ambiguous', note: `Sources describe more than one person named ${subject.name} (${candidates.slice(0, 4).map((c) => c.value).join('; ')}). Add the company so records can be matched to the right person.` };
  }
  return 0;
}

/**
 * Grade text against the subject, but a company the check only inferred (no company was given) is not
 * proof: a record that names it, and no company that was given or found on a record tied to the person,
 * is at most "likely". An inferred identity must never confirm records, least of all its own evidence.
 */
function gradeOf(subject, text) {
  const graded = matchSubject(subject, text);
  if (graded.level !== 'confirmed') return graded;
  for (const a of subject.anchors.companies.values()) if (a.origin !== 'inferred' && a.test(text)) return graded;
  return { level: 'likely', reasons: graded.reasons };
}

/** Records graded "possible" or "likely" are re-read whenever more is known about the subject. */
function regrade(state, subject) {
  let upgraded = 0;
  for (const f of state.findings) {
    if (f.match === 'confirmed' || f.match === 'company' || f.matchFixed) continue;
    // the text the record was first graded on (which may hold structured context the title lacks)
    const graded = gradeOf(subject, f.gradeText || `${f.title} ${f.quote || ''}`);
    if (matchRank(graded.level) > matchRank(f.match)) { f.match = graded.level; f.matchReasons = graded.reasons; upgraded += 1; }
  }
  return upgraded;
}

function summarize(state) {
  const byCategory = {};
  const byMatch = {};
  for (const f of state.findings) {
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    byMatch[f.match] = (byMatch[f.match] || 0) + 1;
  }
  const threads = {};
  for (const t of Object.values(state.threads)) if (t.trusted) threads[t.kind] = (threads[t.kind] || 0) + 1;
  return {
    phase: state.phase, step: state.step, tasksRun: state.tasksRun, queued: state.queue.length,
    findings: state.findings.length, byCategory, byMatch, threads,
    sources: Object.entries(state.sources).map(([id, s]) => ({ id, label: s.label, runs: s.runs, findings: s.findings, errors: s.errors, lastError: s.lastError || null })),
    identity: state.identity, log: state.log.slice(-14), dropped: state.dropped,
  };
}

/**
 * Run one step: as many queued lookups as fit before `deadline`.
 * Mutates and returns `state`.
 * @param {object} state from startState or a previous step
 * @param {{ connectors: Array, deadline?: number, limits?: object, review?: Function }} options
 *   review(state, { deadline }) -> { threads, searches }: the second reader
 *   (gaps.findGaps). Optional; without it the loop simply stops when dry.
 */
export async function stepDeepCheck(state, { connectors, deadline = Date.now() + LIMITS.stepMs, limits = LIMITS, review = null } = {}) {
  if (state.phase !== 'collect') return { state, progress: summarize(state) };
  const subject = restoreSubject(state);
  const byId = new Map(connectors.map((c) => [c.id, c]));

  // The loop ran dry last round: let the second reader look for what was missed before giving up.
  if (state.needsReview) {
    state.needsReview = false;
    state.reviews = (state.reviews || 0) + 1;
    let added = 0;
    let found = null;
    try {
      found = await withTimeout(Promise.resolve().then(() => review(state, { deadline: Math.min(deadline - 3000, Date.now() + 22000) })), Math.max(1000, Math.min(deadline - 2500, Date.now() + 23000) - Date.now()));
    } catch {
      found = null;
    }
    const fresh = [];
    for (const th of found?.threads || []) {
      const record = noteThread(state, subject, th, 1);
      if (record) fresh.push(record);
    }
    for (const record of fresh) added += pullThread(state, subject, record, connectors);
    const searcher = byId.get('web-search');
    if (searcher && (typeof searcher.enabled !== 'function' || searcher.enabled())) {
      added += enqueue(state, (found?.searches || []).map((query) => ({
        connector: searcher.id, kind: 'subject', value: subject.name, depth: 1,
        template: GAP_TEMPLATE, params: { query }, prior: 0.5, why: 'a gap the review of the records pointed to', relation: null,
      })));
    }
    state.anchors = exportAnchors(subject);
    if (added > 0) {
      state.drySteps = 0;
      state.log.push({ step: state.step, text: `A second reading of the records found ${fresh.length} more thread${fresh.length === 1 ? '' : 's'} and ${(found?.searches || []).length} more search${(found?.searches || []).length === 1 ? '' : 'es'} to run.` });
    } else {
      if (state.queue.length) { state.dropped.tasks += state.queue.length; state.queue = []; }
      state.log.push({ step: state.step, text: 'A second reading of the records found nothing more to follow.' });
      state.phase = 'report';
      return { state, progress: summarize(state) };
    }
  }

  if (state.step === 0 && state.queue.length === 0 && state.tasksRun === 0) {
    enqueue(state, planTasks({ kind: 'subject', value: subject.name, why: 'the person being checked' }, 0, connectors, subject));
    if (subject.company) {
      const record = noteThread(state, subject, { kind: 'company', value: subject.company, why: 'the company given', trusted: true }, 1);
      if (record) pullThread(state, subject, record, connectors);
    }
    // A source that is off because a fuller one replaced it is not something that failed to answer
    const isOn = (c) => typeof c.enabled !== 'function' || c.enabled();
    const off = connectors.filter((c) => !isOn(c) && !(c.replacedBy && connectors.some((o) => o.id === c.replacedBy && isOn(o))));
    for (const c of off) state.sources[c.id] = { label: c.label, runs: 0, findings: 0, errors: 0, ms: 0, off: true, lastError: c.unavailableReason || 'Not enabled on this deployment.' };
  }

  // Best-first: what kind of thread it is, how deep, and what this source and query pattern have yielded before.
  const stats = await loadStats('query');
  const priors = new Map();
  for (const t of state.queue) if (!priors.has(learnKey(t))) priors.set(learnKey(t), t.prior);
  const learned = new Map(rankByLearning([...priors].map(([key, prior]) => ({ key, prior })), stats).map((x) => [x.key, x.score]));
  // A thread several records point to (a company named again and again) goes before one seen once.
  const attested = (t) => 1 + Math.min(5, (state.threads[threadKey(t)]?.support || 1) - 1) * 0.08;
  const order = state.queue
    .map((t, i) => ({ t, i, score: (KIND_WEIGHT[t.kind] ?? 0.5) * (DEPTH_WEIGHT[t.depth] ?? 0.4) * (0.4 + (learned.get(learnKey(t)) ?? 0.5)) * attested(t) }))
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .map((x) => x.t);

  const room = Math.max(0, limits.maxTasks - state.tasksRun);
  const batch = order.slice(0, room);
  const seenIds = new Set(state.findings.map((f) => f.id));
  const seenUrls = new Set(state.findings.map(pageKey));
  const perSource = {};
  for (const f of state.findings) perSource[f.source] = (perSource[f.source] || 0) + 1;

  const taken = new Set(); // lookups of the batch already claimed
  const inFlight = new Map(); // connector id -> lookups running now
  const claim = () => {
    const now = Date.now();
    for (let i = 0; i < batch.length; i += 1) {
      if (taken.has(batch[i])) continue;
      if (batch[i].notBefore && batch[i].notBefore > now) continue; // its host is resting
      const source = byId.get(batch[i].connector);
      const limit = source?.maxParallel || Infinity;
      if ((inFlight.get(batch[i].connector) || 0) >= limit) continue; // that source is busy: leave it queued
      taken.add(batch[i]);
      inFlight.set(batch[i].connector, (inFlight.get(batch[i].connector) || 0) + 1);
      return batch[i];
    }
    return null;
  };
  let newFindings = 0;
  const newThreads = [];
  const outcomes = [];
  const reliability = [];
  const ran = new Set();
  const ctxBase = { subject, known: () => exportAnchors(subject) };

  const worker = async () => {
    for (;;) {
      if (Date.now() > deadline - 2500) return;
      const task = claim();
      if (!task) {
        // Nothing to run now. If a lookup waits for a resting host that is back well before the deadline,
        // wait for it rather than ending the step (and spinning through empty steps).
        const next = Math.min(...batch.filter((t) => !taken.has(t) && t.notBefore && t.notBefore > Date.now()).map((t) => t.notBefore));
        if (Number.isFinite(next) && next < deadline - 6000) { await sleep(next - Date.now() + 5); continue; }
        return;
      }
      const c = byId.get(task.connector);
      ran.add(taskKey(task));
      if (!c) { inFlight.set(task.connector, (inFlight.get(task.connector) || 1) - 1); continue; }
      const started = Date.now();
      const taskDeadline = Math.min(deadline, started + (c.timeoutMs || limits.taskTimeoutMs));
      const stat = state.sources[c.id] || (state.sources[c.id] = { label: c.label, runs: 0, findings: 0, errors: 0, ms: 0 });
      let result = null;
      try {
        result = connectorResult(await withTimeout(Promise.resolve().then(() => c.run(task, { ...ctxBase, deadline: taskDeadline })), taskDeadline - started + 400));
      } catch (error) {
        const message = String(error?.message || error);
        // The step ran out of time before this lookup got its turn (it was queued behind others for the
        // same host, or the step's deadline cut it short). That is not the source failing: run it next step.
        const cutShort = taskDeadline >= deadline - 50 && /out of time|timed out/i.test(message);
        if (cutShort && (task.retries || 0) < 2) {
          task.retries = (task.retries || 0) + 1;
          ran.delete(taskKey(task));
          inFlight.set(task.connector, (inFlight.get(task.connector) || 1) - 1);
          continue;
        }
        // Its host is resting, or its turn could not come in time: put it back to run after the rest.
        if (HOST_RESTING.test(message) && (task.rests || 0) < (limits.maxRests ?? LIMITS.maxRests)) {
          task.rests = (task.rests || 0) + 1;
          task.notBefore = Date.now() + (limits.restMs ?? LIMITS.restMs);
          ran.delete(taskKey(task));
          taken.delete(task);
          inFlight.set(task.connector, (inFlight.get(task.connector) || 1) - 1);
          continue;
        }
        stat.errors += 1;
        stat.lastError = plainFailure(message);
        if (process.env.NODE_ENV !== 'test') console.warn(`[deep-check] ${c.id} failed: ${message.slice(0, 300)}`);
      }
      inFlight.set(task.connector, (inFlight.get(task.connector) || 1) - 1);
      const ms = Date.now() - started;
      stat.runs += 1;
      stat.ms += ms;
      reliability.push({ key: c.id, win: Boolean(result), ms });
      // A failed lookup says something about the source (reliability), not about the query pattern.
      if (!result) continue;
      // A record graded on a company the check only inferred is at most "likely".
      for (const f of result.findings) {
        if (f.match !== 'confirmed' || f.matchFixed) continue;
        const graded = gradeOf(subject, f.gradeText || `${f.title} ${f.quote || ''}`);
        if (graded.level !== 'confirmed') { f.match = graded.level; f.matchReasons = graded.reasons; }
      }
      let strong = 0;
      let weak = 0;
      for (const f of result.findings) {
        const dupKey = pageKey(f);
        if (seenIds.has(f.id) || (seenUrls.has(dupKey) && f.category !== 'archive')) {
          // another source (or pattern) found the same record: partial credit, not none
          if (f.match === 'possible') weak += 0.5; else strong += 0.5;
          continue;
        }
        if (state.findings.length >= limits.maxFindings || (perSource[f.source] || 0) >= limits.maxPerSource) { state.dropped.findings += 1; continue; }
        seenIds.add(f.id);
        seenUrls.add(dupKey);
        perSource[f.source] = (perSource[f.source] || 0) + 1;
        // A record found while looking at an associate or relative is filed under that person in the report
        const about = task.kind === 'associate' || task.kind === 'relative' ? { data: { ...(f.data || {}), person: f.data?.person || task.value } } : {};
        state.findings.push({ ...f, ...about, step: state.step, via: task.kind === 'subject' ? null : `${task.kind}: ${task.value}` });
        stat.findings += 1;
        newFindings += 1;
        if (f.match === 'possible') weak += 1; else strong += 1;
      }
      for (const th of result.threads) newThreads.push({ th, depth: task.depth + 1, evidence: evidenceFor(task, result.findings, th) });
      for (const note of result.notes) if (!state.log.some((l) => l.text === note)) state.log.push({ step: state.step, text: note });
      outcomes.push({ key: learnKey(task), win: strong >= 1 ? 1 : strong > 0 ? 0.5 : weak > 0 ? 0.4 : result.threads.length ? 0.25 : 0, ms });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limits.concurrency) }, worker));

  state.tasksRun += ran.size;
  state.done.push(...ran);
  state.queue = state.queue.filter((t) => !ran.has(taskKey(t)));

  // Read what came back for new threads, then pull them.
  let pulled = 0;
  const fresh = [];
  for (const { th, depth, evidence } of newThreads) {
    const record = noteThread(state, subject, th, depth, evidence);
    if (record) fresh.push(record);
  }
  // Only so many threads of each kind are pulled: take the best attested first
  fresh.sort((a, b) => (b.support || 1) - (a.support || 1));
  for (const record of fresh) pulled += pullThread(state, subject, record, connectors);
  pulled += resolveIdentity(state, subject, connectors);
  const upgraded = regrade(state, subject);
  state.anchors = exportAnchors(subject);

  await Promise.all([recordStats('query', outcomes), recordStats('source', reliability)]);

  const PLURAL = { company: 'companies', school: 'schools', associate: 'associates', relative: 'relatives', handle: 'handles', domain: 'domains', url: 'pages' };
  const kinds = fresh.reduce((m, t) => { m[t.kind] = (m[t.kind] || 0) + 1; return m; }, {});
  const kindsText = Object.entries(kinds).map(([kind, n]) => `${n} ${n === 1 ? (kind === 'url' ? 'page' : kind) : PLURAL[kind] || `${kind}s`}`).join(', ');
  state.log.push({ step: state.step, text: `Round ${state.step + 1}: ${ran.size} lookups, ${newFindings} new records${fresh.length ? `, ${fresh.length} new threads to pull (${kindsText})` : ''}${upgraded ? `, ${upgraded} earlier records now tied to the person` : ''}.` });

  // Nothing ran because every remaining lookup waits for a resting host: not a round, and not a dry one.
  if (ran.size === 0 && state.queue.some((t) => t.notBefore && t.notBefore > Date.now())) {
    state.log.pop();
    return { state, progress: summarize(state) };
  }

  state.step += 1;
  // A round only counts as dry when lookups actually ran and found nothing
  state.drySteps = ran.size > 0 && newFindings === 0 && fresh.length === 0 && pulled === 0 ? state.drySteps + 1 : ran.size > 0 ? 0 : state.drySteps;
  const spent = state.tasksRun >= limits.maxTasks;
  const dry = state.queue.length === 0 || state.drySteps >= limits.dryStepsToStop;
  if (dry && !spent && state.step < limits.maxSteps && typeof review === 'function' && (state.reviews || 0) < (limits.maxReviews ?? 0) && state.findings.length > 0) {
    // Not finished yet: the next step starts with a second reading of the records.
    state.needsReview = true;
  } else if (state.queue.length === 0 || spent || state.step >= limits.maxSteps || state.drySteps >= limits.dryStepsToStop) {
    if (state.queue.length) {
      state.dropped.tasks += state.queue.length;
      state.log.push({ step: state.step, text: `Stopped with ${state.queue.length} lookups not run (${spent ? 'the lookup budget for one check was reached' : state.drySteps >= limits.dryStepsToStop ? 'the last rounds found nothing new' : 'the round limit was reached'}).` });
      state.queue = [];
    }
    state.phase = 'report';
  }
  return { state, progress: summarize(state) };
}

/** Progress for a state without running anything. */
export function progressOf(state) {
  return summarize(state);
}
