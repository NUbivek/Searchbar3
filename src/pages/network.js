/**
 * Network Map: import your own contacts (LinkedIn's Connections.csv export,
 * any CSV/XLSX, or your X following list), see them as a company graph, and
 * ask questions like "Who do I know at Stripe?" or "Intro paths to OpenAI".
 *
 * Signed in: contacts are saved to your account (/api/network/contacts).
 * Signed out: contacts stay in this browser tab only.
 * Only first-degree connections exist in these exports; nothing is invented.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from 'next-auth/react';
import {
  HiOutlineArrowUpTray, HiOutlineTrash, HiOutlineXMark, HiOutlineArrowTopRightOnSquare, HiOutlineMagnifyingGlass,
  HiOutlineShare, HiOutlineSparkles, HiOutlineDocumentText,
} from 'react-icons/hi2';
import PageShell from '../components/layout/PageShell';
import NetworkGraph, { SOURCE_COLORS } from '../components/network/NetworkGraph';
import {
  parseContactsFile, parseXFollowing, dedupeContacts, countBySource, dedupeKey, normalizeCompanyKey, MAX_CONTACTS,
} from '../utils/network/parseContacts';
import { buildGraph, personNodeId, companyNodeId, NO_COMPANY_KEY, MAX_PEOPLE_PER_EXPANDED_COMPANY } from '../utils/network/graph';

function classNames(...classes) {
  return classes.filter(Boolean).join(' ');
}

const ICON = { width: 15, height: 15 };
const SOURCE_LABELS = { linkedin: 'LinkedIn', csv: 'CSV/XLSX', x: 'X' };
const EXAMPLES = ['Who do I know at Google?', 'Find software engineers in my network', 'Intro paths to Stripe'];
const MAX_FILE_BYTES = 25 * 1024 * 1024;
// The contacts API accepts 15 MB request bodies; stop a little short of it.
const MAX_BODY_BYTES = 14 * 1024 * 1024;
// Answers expand the companies of the top matches, but not huge ones.
const AUTO_EXPAND_MAX_PEOPLE = 60;
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const LINKEDIN_UNAVAILABLE = "LinkedIn connection isn't available on this deployment yet";
const X_UNAVAILABLE = "X connection isn't available on this deployment yet";

// OAuth redirects come back with ?error=<code>; only these are shown.
const AUTH_ERRORS = {
  linkedin_not_configured: `${LINKEDIN_UNAVAILABLE}.`,
  linkedin_denied: 'LinkedIn sign-in was cancelled.',
  linkedin_state: 'LinkedIn sign-in could not be verified. Please try connecting again.',
  linkedin_failed: 'LinkedIn sign-in did not complete. Please try again.',
  twitter_not_configured: `${X_UNAVAILABLE}.`,
  twitter_denied: 'X sign-in was cancelled.',
  twitter_state: 'X sign-in could not be verified. Please try connecting again.',
  twitter_expired: 'The X sign-in session expired. Please try connecting again.',
  twitter_failed: 'X sign-in did not complete. Please try again.',
};
const authErrorText = (code) => AUTH_ERRORS[String(code || '')] || 'Sign-in did not complete. Please try again.';

const formatDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', ...(iso.length === 10 ? { timeZone: 'UTC' } : {}) });
};
const formatTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

async function readJson(response) {
  try { return await response.json(); } catch { return {}; }
}

/** Small brand marks for the import cards (no brand icon set is loaded). */
function SourceMark({ source }) {
  if (source === 'linkedin') {
    return <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#0077B5] text-[11px] font-bold text-white" aria-hidden="true">in</span>;
  }
  if (source === 'x') {
    return <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-ink text-[12px] font-bold text-white" aria-hidden="true">X</span>;
  }
  return <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600" aria-hidden="true"><HiOutlineDocumentText style={{ width: 16, height: 16 }} /></span>;
}

function SourceBadge({ source }) {
  return (
    <span className="chip">
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: SOURCE_COLORS[source] || SOURCE_COLORS.csv }} />
      {SOURCE_LABELS[source] || source}
    </span>
  );
}

function ContactActions({ name, company }) {
  if (!company && !name) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {company && (
        <>
          <Link href={`/company/${encodeURIComponent(company)}`} className="btn-primary px-3 py-1.5 text-xs">Company profile</Link>
          <Link href={`/?q=${encodeURIComponent(company)}`} className="btn-secondary px-3 py-1.5 text-xs">Search company</Link>
        </>
      )}
      {name && (
        <Link
          href={`/founder?name=${encodeURIComponent(name)}${company ? `&company=${encodeURIComponent(company)}` : ''}`}
          className="btn-secondary px-3 py-1.5 text-xs"
        >
          Founder check
        </Link>
      )}
    </div>
  );
}

function ResultRow({ item, onShow }) {
  const c = item.contact;
  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => onShow(c)} className="text-left text-sm font-medium text-ink hover:text-brand-600">{c.name}</button>
            {c.company && <span className="chip">{c.company}</span>}
          </div>
          <div className="mt-0.5 truncate text-sm text-slate-600">{c.position || (c.company ? '' : 'No title or company listed')}</div>
          {item.reasons.length > 0 && <p className="mt-1 text-xs text-muted">{item.reasons.join(' · ')}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <SourceBadge source={c.source} />
          {c.profileUrl && (
            <a href={c.profileUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
              Profile <HiOutlineArrowTopRightOnSquare style={{ width: 12, height: 12 }} />
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

function Count({ label, value, hint }) {
  return (
    <div className="text-right">
      <div className="eyebrow">{label}</div>
      <div className="text-lg font-semibold tracking-tight text-ink">{fmt(value)}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}

export default function NetworkPage() {
  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession();
  const signedIn = sessionStatus === 'authenticated';

  const [contacts, setContacts] = useState([]);
  const [mode, setMode] = useState('loading'); // loading | saved | memory
  const [stats, setStats] = useState(null);
  const [memoryImports, setMemoryImports] = useState({});
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(null); // { kind: 'error'|'success'|'info', text }
  const [busy, setBusy] = useState(null);

  const [linkedin, setLinkedin] = useState({ checked: false, connected: false, name: '', configured: true });
  const [xStatus, setXStatus] = useState({ checked: false, connected: false, username: '', note: '', configured: true });
  // Shown inline when a connection is offered but not available on this deployment.
  const [unavailable, setUnavailable] = useState({ linkedin: false, x: false });

  const [sourceFilter, setSourceFilter] = useState({ linkedin: true, csv: true, x: true });
  const [companyFilter, setCompanyFilter] = useState('');
  const [graphSearch, setGraphSearch] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [selected, setSelected] = useState(null);

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [askError, setAskError] = useState('');

  const graphBoxRef = useRef(null);
  const [graphWidth, setGraphWidth] = useState(0);
  const linkedinInput = useRef(null);
  const genericInput = useRef(null);

  // ------------------------------------------------------------ loading

  const loadSaved = useCallback(async () => {
    const response = await fetch('/api/network/contacts');
    const data = await readJson(response);
    if (response.status === 503) {
      setMode('memory');
      setLoadError('Saving is not available right now (no database is configured), so your network is kept in this tab only.');
      return;
    }
    if (!response.ok) throw new Error(data.error || `Could not load your network (${response.status})`);
    setContacts(Array.isArray(data.contacts) ? data.contacts : []);
    setStats(data.stats || null);
    setMode('saved');
    setLoadError('');
  }, []);

  useEffect(() => {
    if (sessionStatus === 'loading') return;
    if (sessionStatus !== 'authenticated') {
      setMode('memory');
      return;
    }
    setMode('loading');
    loadSaved().catch((error) => {
      setMode('memory');
      setLoadError(`${error.message}. Imports will be kept in this tab only.`);
    });
  }, [sessionStatus, loadSaved]);

  const checkSocial = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/linkedin/token');
      const d = await readJson(r);
      const name = [d.user?.firstName, d.user?.lastName].filter(Boolean).join(' ');
      setLinkedin({ checked: true, connected: Boolean(d.isAuthenticated), name, configured: d.configured !== false });
    } catch {
      setLinkedin({ checked: true, connected: false, name: '', configured: true });
    }
    try {
      const r = await fetch('/api/auth/twitter/token');
      const d = await readJson(r);
      const configured = d.configured !== false;
      if (r.status === 429) {
        setXStatus({ checked: true, connected: false, username: '', note: 'X status is temporarily unavailable (rate limited).', configured });
      } else {
        setXStatus({ checked: true, connected: Boolean(d.authenticated), username: d.profile?.username || '', note: '', configured });
      }
    } catch {
      setXStatus({ checked: true, connected: false, username: '', note: '', configured: true });
    }
  }, []);

  useEffect(() => { checkSocial(); }, [checkSocial]);

  // OAuth callbacks come back as ?auth=linkedin_success / ?error=...
  useEffect(() => {
    if (!router.isReady) return;
    const { error, auth } = router.query;
    if (!error && !auth) return;
    if (error) setNotice({ kind: 'error', text: authErrorText(error) });
    if (auth === 'linkedin_success') setNotice({ kind: 'success', text: 'LinkedIn connected (profile only). Upload Connections.csv to add your connections.' });
    if (auth === 'twitter_success') setNotice({ kind: 'success', text: 'X connected.' });
    checkSocial();
    router.replace('/network', undefined, { shallow: true });
  }, [router.isReady, router.query, router, checkSocial]);

  // Graph width follows its container.
  useEffect(() => {
    const el = graphBoxRef.current;
    if (!el) return undefined;
    const update = () => setGraphWidth(Math.max(280, Math.floor(el.clientWidth)));
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [contacts.length > 0]);

  // ------------------------------------------------------------ import

  /**
   * Save (signed in) or keep (signed out) one source's contacts. Returns the
   * notice text; `fileTruncated` is how many the parser already dropped at
   * the 30,000 limit, so the counts in the notice add up.
   */
  const saveSource = async (source, list, { fileTruncated = 0 } = {}) => {
    const deduped = dedupeContacts(list).slice(0, MAX_CONTACTS);
    const overLimit = (n) => `${fmt(n)} over the ${fmt(MAX_CONTACTS)} limit were not ${mode === 'saved' ? 'saved' : 'loaded'}`;
    if (mode === 'saved') {
      const body = JSON.stringify({ source, contacts: deduped });
      if (body.length > MAX_BODY_BYTES) {
        throw new Error(`This import is too large to save in one go (${(body.length / 1048576).toFixed(1)} MB; the limit is 14 MB). Remove unneeded columns such as notes or tags, or split the file, and try again.`);
      }
      const response = await fetch('/api/network/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const data = await readJson(response);
      if (response.status !== 503) {
        if (response.status === 413) throw new Error('The server refused this import because it is too large (over 15 MB). Split the file and try again.');
        if (response.status === 400 && !data.error) throw new Error('The server could not read this import. Please try the upload again.');
        if (!response.ok) throw new Error(data.error || `Import failed (${response.status})`);
        if (Array.isArray(data.contacts)) {
          // The server returns what it saved for this source: merge it in
          // instead of downloading the whole network again.
          setContacts((prev) => [...prev.filter((c) => c.source !== source), ...data.contacts]);
          if (data.stats) setStats(data.stats);
        } else {
          await loadSaved();
        }
        const extra = [
          data.duplicates ? `${fmt(data.duplicates)} already saved from another source` : '',
          (Number(data.truncated) || 0) + fileTruncated ? overLimit((Number(data.truncated) || 0) + fileTruncated) : '',
        ].filter(Boolean).join('; ');
        return `Saved ${fmt(data.saved)} ${SOURCE_LABELS[source]} contacts to your account${extra ? ` (${extra})` : ''}.`;
      }
      setMode('memory');
      setLoadError('Saving is not available right now (no database is configured), so your network is kept in this tab only.');
    }
    // Signed out: merge in memory, then report what is actually there.
    const others = contacts.filter((c) => c.source !== source);
    const merged = dedupeContacts([...others, ...deduped]);
    const kept = merged.slice(0, MAX_CONTACTS);
    const loaded = kept.filter((c) => c.source === source).length;
    const dropped = merged.length - kept.length + fileTruncated;
    const dupes = others.length + deduped.length - merged.length;
    setContacts(kept);
    setMemoryImports((prev) => ({ ...prev, [source]: new Date().toISOString() }));
    const extra = [
      dupes ? `${fmt(dupes)} already loaded from another source` : '',
      dropped ? overLimit(dropped) : '',
    ].filter(Boolean).join('; ');
    return `Loaded ${fmt(loaded)} ${SOURCE_LABELS[source]} contacts into this tab${extra ? ` (${extra})` : ''}.`;
  };

  const handleFile = async (event, kind) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setNotice(null);
    if (file.size > MAX_FILE_BYTES) {
      setNotice({ kind: 'error', text: 'That file is larger than 25 MB. Export only the contacts you need and try again.' });
      return;
    }
    setBusy(kind);
    try {
      const parsed = await parseContactsFile(file, { kind });
      if (!parsed.headerFound) {
        let text;
        if (parsed.reason === 'not-linkedin') {
          text = 'This is a contacts file, not LinkedIn\'s Connections.csv (no First Name, Last Name and Connected On columns), so it was not imported. Use "Upload CSV/XLSX contacts" for it; your LinkedIn import is unchanged.';
        } else if (kind === 'linkedin') {
          text = 'This does not look like LinkedIn\'s Connections.csv: no header row with First Name, Last Name, Company, Position and Connected On was found.';
        } else {
          text = 'No contacts found: the file needs a header row with a name column (Name, or First Name and Last Name) and ideally Company and Title.';
        }
        setNotice({ kind: 'error', text });
        return;
      }
      if (!parsed.contacts.length) {
        setNotice({ kind: 'error', text: 'The file has a header row but no contacts with a name.' });
        return;
      }
      const message = await saveSource(parsed.source, parsed.contacts, { fileTruncated: parsed.truncated || 0 });
      const details = [
        parsed.skippedRows ? `${fmt(parsed.skippedRows)} rows without a name were skipped.` : '',
        parsed.duplicates ? `${fmt(parsed.duplicates)} duplicate rows in the file were merged.` : '',
      ].filter(Boolean).join(' ');
      setNotice({ kind: 'success', text: `${message}${details ? ` ${details}` : ''}` });
      setAnswer(null);
    } catch (error) {
      setNotice({ kind: 'error', text: `Import failed: ${error.message}` });
    } finally {
      setBusy(null);
    }
  };

  const importX = async () => {
    setBusy('x');
    setNotice(null);
    try {
      const response = await fetch('/api/network/twitter');
      const data = await readJson(response);
      if (response.status === 401) {
        setXStatus((s) => ({ ...s, connected: false }));
        throw new Error('Your X session expired. Connect X again.');
      }
      if (!response.ok) throw new Error(data.error || `X request failed (${response.status})`);
      if (!data.followingAvailable) {
        setXStatus((s) => ({ ...s, note: data.note || data.error || 'X did not return your following list.' }));
        setNotice({ kind: 'info', text: data.note || data.error || 'X did not return your following list.' });
        return;
      }
      const parsed = parseXFollowing({ data: data.following || [] });
      if (!parsed.contacts.length) {
        setNotice({ kind: 'info', text: 'X returned an empty following list.' });
        return;
      }
      const message = await saveSource('x', parsed.contacts, { fileTruncated: parsed.truncated || 0 });
      const dupes = parsed.duplicates ? ` ${fmt(parsed.duplicates)} duplicate accounts were merged.` : '';
      setNotice({ kind: 'success', text: `${message}${dupes}${data.note ? ` ${data.note}` : ''}` });
    } catch (error) {
      setNotice({ kind: 'error', text: error.message });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (service) => {
    try {
      await fetch(`/api/auth/${service}/logout`);
    } catch {
      // cookies are cleared server side; nothing else to do
    }
    if (service === 'linkedin') setLinkedin((s) => ({ ...s, checked: true, connected: false, name: '' }));
    else setXStatus((s) => ({ ...s, checked: true, connected: false, username: '', note: '' }));
  };

  const removeAll = async () => {
    if (!contacts.length) return;
    const where = mode === 'saved' ? 'from your account' : 'from this tab';
    if (typeof window !== 'undefined' && !window.confirm(`Remove all ${contacts.length.toLocaleString('en-US')} contacts ${where}? This cannot be undone.`)) return;
    setBusy('delete');
    try {
      if (mode === 'saved') {
        const response = await fetch('/api/network/contacts', { method: 'DELETE' });
        const data = await readJson(response);
        if (!response.ok) throw new Error(data.error || `Delete failed (${response.status})`);
        setStats(data.stats || null);
      }
      setContacts([]);
      setMemoryImports({});
      setAnswer(null);
      setSelected(null);
      setExpanded(new Set());
      setNotice({ kind: 'success', text: 'All of your network data was removed.' });
    } catch (error) {
      setNotice({ kind: 'error', text: error.message });
    } finally {
      setBusy(null);
    }
  };

  // ------------------------------------------------------------ graph

  const counts = useMemo(() => countBySource(contacts), [contacts]);

  const visibleContacts = useMemo(() => {
    const q = companyFilter.trim().toLowerCase();
    const qKey = normalizeCompanyKey(companyFilter);
    return contacts.filter((c) => {
      if (!sourceFilter[c.source]) return false;
      if (!q) return true;
      const company = String(c.company || '').toLowerCase();
      return company.includes(q) || (qKey && normalizeCompanyKey(c.company).includes(qKey));
    });
  }, [contacts, sourceFilter, companyFilter]);

  const graph = useMemo(() => buildGraph(visibleContacts, {
    expanded,
    meLabel: session?.user?.name ? `You (${session.user.name.split(' ')[0]})` : 'You',
  }), [visibleContacts, expanded, session?.user?.name]);

  const answerKeys = useMemo(() => {
    if (!answer) return null;
    const keys = new Set();
    (answer.results || []).forEach((r) => keys.add(r.contact.key));
    (answer.intro?.viaInvestors || []).forEach((g) => g.contacts.forEach((r) => keys.add(r.contact.key)));
    return keys;
  }, [answer]);

  const highlightIds = useMemo(() => {
    const ids = new Set();
    const term = graphSearch.trim().toLowerCase();
    if (!term && !answerKeys) return ids;
    for (const c of visibleContacts) {
      const hitSearch = term && [c.name, c.company, c.position].some((v) => String(v || '').toLowerCase().includes(term));
      const hitAnswer = answerKeys && answerKeys.has(dedupeKey(c));
      if (hitSearch || hitAnswer) {
        ids.add(personNodeId(c));
        ids.add(companyNodeId(normalizeCompanyKey(c.company) || NO_COMPANY_KEY));
      }
    }
    return ids;
  }, [graphSearch, answerKeys, visibleContacts]);

  // Count only people actually drawn: in a large network most highlighted
  // people sit in companies that are not expanded.
  const highlightedPeople = useMemo(() => {
    let n = 0;
    const drawn = new Set(graph.nodes.map((node) => node.id));
    highlightIds.forEach((id) => { if (id.startsWith('p:') && drawn.has(id)) n += 1; });
    return n;
  }, [highlightIds, graph]);
  const highlightedTotal = useMemo(() => {
    let n = 0;
    highlightIds.forEach((id) => { if (id.startsWith('p:')) n += 1; });
    return n;
  }, [highlightIds]);

  const selectContact = (contact) => {
    const key = normalizeCompanyKey(contact.company) || NO_COMPANY_KEY;
    if (graph.large) setExpanded((prev) => new Set(prev).add(key));
    const full = contacts.find((c) => dedupeKey(c) === contact.key) || contact;
    setSelected({ type: 'person', id: personNodeId(full), contact: full });
    graphBoxRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  };

  const onNodeClick = (node) => {
    if (node.type === 'person') {
      setSelected({ type: 'person', id: node.id, contact: node.contact });
    } else if (node.type === 'company') {
      // Clicking always shows the company's people; hiding is an explicit button
      // (a toggle here would collapse again on a double click).
      if (graph.large && !expanded.has(node.key)) setExpanded((prev) => new Set(prev).add(node.key));
      setSelected({ type: 'company', id: node.id, key: node.key, label: node.label, count: node.count });
    } else {
      setSelected(null);
    }
  };

  const selectedCompanyPeople = useMemo(() => {
    if (selected?.type !== 'company') return [];
    return visibleContacts
      .filter((c) => (normalizeCompanyKey(c.company) || NO_COMPANY_KEY) === selected.key)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [selected, visibleContacts]);

  // ------------------------------------------------------------ ask

  const ask = async (text, { target } = {}) => {
    const q = String(text ?? question).trim();
    if (!q && !target) return;
    if (!contacts.length) {
      setAskError('Import your contacts first: there is nothing to search yet.');
      return;
    }
    setAsking(true);
    setAskError('');
    try {
      const body = { question: q, ...(target ? { target } : {}) };
      if (mode !== 'saved') {
        // Signed out, the server has no copy: send only what scoring uses
        // (never email) plus the identity key so results map back to the graph.
        body.contacts = contacts.map((c) => ({
          key: dedupeKey(c), name: c.name, company: c.company, position: c.position, location: c.location,
          profileUrl: c.profileUrl, connectedOn: c.connectedOn, source: c.source, tags: c.tags,
        }));
      }
      const response = await fetch('/api/network/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.error || `Search failed (${response.status})`);
      setAnswer(data);
      setSelected(null);
      if (graph.large) {
        // Expand the top matches' companies, except very large ones (they
        // would bury the answer); those stay as a company node to click.
        const sizes = new Map(graph.nodes.filter((n) => n.type === 'company').map((n) => [n.key, n.count]));
        const keys = new Set(expanded);
        [...(data.results || []), ...((data.intro?.viaInvestors || []).flatMap((g) => g.contacts))]
          .slice(0, 30)
          .forEach((r) => {
            const key = normalizeCompanyKey(r.contact.company) || NO_COMPANY_KEY;
            if ((sizes.get(key) || 0) <= AUTO_EXPAND_MAX_PEOPLE) keys.add(key);
          });
        setExpanded(keys);
      }
    } catch (error) {
      setAskError(error.message);
    } finally {
      setAsking(false);
    }
  };

  const askExample = (text) => {
    setQuestion(text);
    ask(text);
  };

  const lastImport = (source) => (mode === 'saved' ? stats?.lastImportBySource?.[source] : memoryImports[source]);
  const lastImportAny = mode === 'saved' ? stats?.lastImportAt : Object.values(memoryImports).sort().pop();
  const filtersShown = answer?.filters;

  // ------------------------------------------------------------ render

  const connectLinkedIn = () => {
    if (linkedin.configured) { window.location.assign('/api/auth/linkedin'); return; }
    setUnavailable((u) => ({ ...u, linkedin: true }));
  };
  const connectX = () => {
    if (xStatus.configured) { window.location.assign('/api/auth/twitter'); return; }
    setUnavailable((u) => ({ ...u, x: true }));
  };

  return (
    <PageShell flows
      title="Network Map"
      subtitle="Import your own contacts, see who you know grouped by company, and ask who can make an introduction. Nothing is added that is not in your files."
      wide
    >
      <div className="space-y-5">
        {notice && (
          <div
            role={notice.kind === 'error' ? 'alert' : 'status'}
            className={classNames(
              'flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm',
              notice.kind === 'error' && 'border-rose-200 bg-rose-50 text-rose-700',
              notice.kind === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-800',
              notice.kind === 'info' && 'border-brand-200 bg-brand-50 text-brand-700'
            )}
          >
            <span>{notice.text}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><HiOutlineXMark style={ICON} /></button>
          </div>
        )}

        {/* ---------------------------------------------------- import */}
        <section aria-labelledby="import-heading" className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="import-heading" className="section-title">Your network</h2>
              <p className="muted">Only your first-degree connections are in these files; nothing else is added.</p>
            </div>
            {mode === 'loading' ? (
              <span className="muted">Loading your network…</span>
            ) : (
              <Count
                label="Contacts"
                value={contacts.length}
                hint={`${mode === 'saved' ? 'Saved to your account' : 'Kept in this tab only'}${lastImportAny ? ` · last import ${formatTime(lastImportAny)}` : ''}`}
              />
            )}
          </div>

          {mode === 'memory' && !signedIn && sessionStatus !== 'loading' && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <Link href="/signin" className="font-medium underline">Sign in to save your network</Link>. Until then, imports stay in this browser tab and are gone when you close it.
            </div>
          )}
          {loadError && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{loadError}</div>
          )}

          <div className="grid gap-4 md:grid-cols-3">
            {/* LinkedIn */}
            <div className="card card-pad flex flex-col">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <SourceMark source="linkedin" />
                  <h3 className="text-sm font-semibold text-ink">LinkedIn connections</h3>
                </div>
                <Count label="Imported" value={counts.linkedin} hint={lastImport('linkedin') ? formatTime(lastImport('linkedin')) : null} />
              </div>
              <ol className="mb-4 list-decimal space-y-1 pl-4 text-xs text-muted">
                <li>On LinkedIn, open <span className="font-medium text-slate-700">Settings &amp; Privacy → Data privacy → Get a copy of your data</span>.</li>
                <li>Choose <span className="font-medium text-slate-700">Connections</span> (or the full archive) and request the archive.</li>
                <li>LinkedIn emails a download link, usually within minutes. Unzip it.</li>
                <li>Upload <span className="font-medium text-slate-700">Connections.csv</span> here.</li>
              </ol>
              <input ref={linkedinInput} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => handleFile(e, 'linkedin')} data-testid="linkedin-file" />
              <div className="mt-auto">
                <button
                  type="button"
                  onClick={() => linkedinInput.current?.click()}
                  disabled={Boolean(busy) || mode === 'loading'}
                  className="btn-primary w-full"
                >
                  <HiOutlineArrowUpTray style={ICON} /> {busy === 'linkedin' ? 'Importing…' : 'Upload LinkedIn Connections.csv'}
                </button>
                <div className="mt-3 border-t border-line pt-3 text-xs text-muted">
                  {linkedin.connected ? (
                    <div className="flex items-center justify-between gap-2">
                      <span>Connected as <span className="font-medium text-slate-700">{linkedin.name || 'your LinkedIn profile'}</span> (profile only).</span>
                      <button type="button" onClick={() => disconnect('linkedin')} className="btn-ghost shrink-0 px-2 py-1 text-xs">Disconnect</button>
                    </div>
                  ) : (
                    <>
                      <p>Connecting LinkedIn only shares your own profile: LinkedIn does not give apps your connections, so the Connections.csv export above is how they come in.</p>
                      <button type="button" onClick={connectLinkedIn} className="btn-secondary mt-2 w-full py-2 text-xs">Connect LinkedIn</button>
                      {unavailable.linkedin && !linkedin.configured && <p className="muted mt-2 text-xs" role="status">{LINKEDIN_UNAVAILABLE}.</p>}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* CSV / XLSX */}
            <div className="card card-pad flex flex-col">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <SourceMark source="csv" />
                  <h3 className="text-sm font-semibold text-ink">Other contacts</h3>
                </div>
                <Count label="Imported" value={counts.csv} hint={lastImport('csv') ? formatTime(lastImport('csv')) : null} />
              </div>
              <p className="mb-4 text-xs text-muted">
                Any CSV or XLSX with a header row: Name (or First/Last Name), Company, Title, Email, LinkedIn URL, Location, Tags. A new upload replaces your previous CSV/XLSX import.
              </p>
              <input ref={genericInput} type="file" accept=".csv,.tsv,.xlsx,.xls,.json,text/csv,application/json" className="hidden" onChange={(e) => handleFile(e, 'auto')} data-testid="generic-file" />
              <div className="mt-auto">
                <button
                  type="button"
                  onClick={() => genericInput.current?.click()}
                  disabled={Boolean(busy) || mode === 'loading'}
                  className="btn-primary w-full"
                >
                  <HiOutlineArrowUpTray style={ICON} /> {busy === 'auto' ? 'Importing…' : 'Upload CSV/XLSX contacts'}
                </button>
              </div>
            </div>

            {/* X */}
            <div className="card card-pad flex flex-col">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <SourceMark source="x" />
                  <h3 className="text-sm font-semibold text-ink">X following</h3>
                </div>
                <Count label="Imported" value={counts.x} hint={lastImport('x') ? formatTime(lastImport('x')) : null} />
              </div>
              {xStatus.connected ? (
                <>
                  <p className="mb-4 text-xs text-muted">Connected as <span className="font-medium text-slate-700">@{xStatus.username || 'unknown'}</span>. If X does not share who you follow with this app, you will see a note instead; an X following export can be uploaded under Other contacts.</p>
                  <div className="mt-auto space-y-2">
                    <button type="button" onClick={importX} disabled={Boolean(busy)} className="btn-primary w-full">
                      {busy === 'x' ? 'Importing…' : 'Import accounts I follow'}
                    </button>
                    <button type="button" onClick={() => disconnect('twitter')} className="btn-ghost w-full justify-center text-xs">Disconnect</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="mb-4 text-xs text-muted">X does not share who you follow with this app yet; upload an X following export (JSON) under Other contacts instead.</p>
                  <div className="mt-auto">
                    <button type="button" onClick={connectX} className="btn-secondary w-full">Connect X</button>
                    {unavailable.x && !xStatus.configured && <p className="muted mt-2 text-xs" role="status">{X_UNAVAILABLE}.</p>}
                  </div>
                </>
              )}
              {xStatus.note && <p className="mt-2 text-xs text-amber-700">{xStatus.note}</p>}
            </div>
          </div>

          {contacts.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-1">
              <p className="muted text-xs">Your contacts are only used to answer your own questions. They are never sent to AI models or other services.</p>
              <button type="button" onClick={removeAll} disabled={Boolean(busy)} className="btn-danger text-xs disabled:opacity-50">
                <HiOutlineTrash style={{ width: 13, height: 13 }} /> {busy === 'delete' ? 'Removing…' : 'Remove all my network data'}
              </button>
            </div>
          )}
        </section>

        {/* ---------------------------------------------------- graph */}
        <section className="card card-pad" aria-labelledby="graph-heading">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 id="graph-heading" className="section-title">Network graph</h2>
            {contacts.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5" aria-label="Sources shown">
                {['linkedin', 'csv', 'x'].map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="checkbox"
                    aria-checked={sourceFilter[s]}
                    disabled={!counts[s]}
                    onClick={() => setSourceFilter((f) => ({ ...f, [s]: !f[s] }))}
                    className={classNames('chip', sourceFilter[s] && 'chip-active', !counts[s] && 'opacity-50')}
                  >
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: SOURCE_COLORS[s] }} />
                    {SOURCE_LABELS[s]} <span className="text-muted">{fmt(counts[s])}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {contacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <span className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-600"><HiOutlineShare style={{ width: 20, height: 20 }} /></span>
              <p className="text-sm font-medium text-ink">{mode === 'loading' ? 'Loading your network…' : 'No contacts yet'}</p>
              {mode !== 'loading' && (
                <>
                  <p className="muted mt-1 max-w-md">Upload LinkedIn&apos;s Connections.csv or a contacts spreadsheet to see who you know, grouped by company.</p>
                  <button type="button" onClick={() => linkedinInput.current?.click()} disabled={Boolean(busy)} className="btn-secondary mt-4">
                    <HiOutlineArrowUpTray style={ICON} /> Upload Connections.csv
                  </button>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-2">
                <input
                  type="search"
                  value={companyFilter}
                  onChange={(e) => { setCompanyFilter(e.target.value); setSelected(null); }}
                  placeholder="Filter by company…"
                  aria-label="Filter by company"
                  className="input min-w-[180px] flex-1 py-2"
                />
                <input
                  type="search"
                  value={graphSearch}
                  onChange={(e) => setGraphSearch(e.target.value)}
                  placeholder="Highlight a name, title or company…"
                  aria-label="Highlight in graph"
                  className="input min-w-[180px] flex-1 py-2"
                />
              </div>
              <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span><span className="font-semibold text-ink">{fmt(visibleContacts.length)}</span> people · <span className="font-semibold text-ink">{fmt(graph.companyCount)}</span> companies</span>
                {graph.large && (
                  <span>
                    Large network: showing companies only{graph.hiddenCompanies ? ` (largest ${fmt(graph.companyCount - graph.hiddenCompanies)}; filter to find others)` : ''}. Click a company to show its people.
                  </span>
                )}
                {graph.cappedCompanies?.length > 0 && (
                  <span>
                    Showing the first {fmt(MAX_PEOPLE_PER_EXPANDED_COMPANY)} people of {graph.cappedCompanies.map((c) => c.label).slice(0, 3).join(', ')}{graph.cappedCompanies.length > 3 ? ` and ${graph.cappedCompanies.length - 3} more` : ''}; everyone is in the company&apos;s details list.
                  </span>
                )}
                {(graphSearch.trim() || answerKeys) && (
                  <span>
                    {fmt(highlightedPeople)} highlighted{graph.large && highlightedTotal > highlightedPeople ? ` (${fmt(highlightedTotal)} match; click a company to show its people)` : ''}
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-4 lg:flex-row">
                <div ref={graphBoxRef} className="min-w-0 flex-1 overflow-hidden rounded-xl border border-line bg-white">
                  {visibleContacts.length === 0 ? (
                    <div className="flex items-center justify-center text-sm text-muted" style={{ height: 560 }}>No contacts match these filters.</div>
                  ) : (
                    <NetworkGraph
                      graphData={graph}
                      width={graphWidth}
                      height={560}
                      highlightIds={highlightIds}
                      selectedId={selected?.id}
                      onNodeClick={onNodeClick}
                      onBackgroundClick={() => setSelected(null)}
                    />
                  )}
                </div>

                <aside className="card card-pad shrink-0 text-sm lg:w-80" aria-label="Details">
                  {!selected && (
                    <div>
                      <p className="eyebrow mb-1">Details</p>
                      <p className="muted">Click a person or company in the graph to see details. Indigo circles are companies, sized by how many people you know there.</p>
                    </div>
                  )}
                  {selected?.type === 'person' && (
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-semibold text-ink">{selected.contact.name}</h3>
                        <button type="button" onClick={() => setSelected(null)} aria-label="Close details" className="text-muted hover:text-ink"><HiOutlineXMark style={ICON} /></button>
                      </div>
                      {selected.contact.position && <p className="text-slate-700">{selected.contact.position}</p>}
                      {selected.contact.company && <p className="mt-1"><span className="chip">{selected.contact.company}</span></p>}
                      <dl className="mt-3 space-y-1 text-xs text-muted">
                        {selected.contact.location && <div><dt className="inline font-medium text-slate-700">Location: </dt><dd className="inline">{selected.contact.location}</dd></div>}
                        {selected.contact.connectedOn && <div><dt className="inline font-medium text-slate-700">Connected on: </dt><dd className="inline">{formatDate(selected.contact.connectedOn)}</dd></div>}
                        {selected.contact.email && <div><dt className="inline font-medium text-slate-700">Email: </dt><dd className="inline break-all">{selected.contact.email}</dd></div>}
                        <div><dt className="inline font-medium text-slate-700">Source: </dt><dd className="inline"><SourceBadge source={selected.contact.source} /></dd></div>
                        {selected.contact.tags?.length > 0 && <div><dt className="inline font-medium text-slate-700">Tags: </dt><dd className="inline">{selected.contact.tags.join(', ')}</dd></div>}
                      </dl>
                      {selected.contact.profileUrl && (
                        <a href={selected.contact.profileUrl} target="_blank" rel="noopener noreferrer nofollow" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
                          Open profile <HiOutlineArrowTopRightOnSquare style={{ width: 12, height: 12 }} />
                        </a>
                      )}
                      <ContactActions name={selected.contact.name} company={selected.contact.company} />
                    </div>
                  )}
                  {selected?.type === 'company' && (
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-semibold text-ink">{selected.label}</h3>
                        <button type="button" onClick={() => setSelected(null)} aria-label="Close details" className="text-muted hover:text-ink"><HiOutlineXMark style={ICON} /></button>
                      </div>
                      <p className="muted">{selected.count} {selected.count === 1 ? 'person' : 'people'} you know</p>
                      {graph.large && expanded.has(selected.key) && (
                        <button
                          type="button"
                          onClick={() => setExpanded((prev) => { const next = new Set(prev); next.delete(selected.key); return next; })}
                          className="btn-ghost mt-1 px-1.5 py-1 text-xs"
                        >
                          Hide these people in the graph
                        </button>
                      )}
                      {selected.key !== NO_COMPANY_KEY && (
                        <>
                          <ContactActions company={selected.label} />
                          <button
                            type="button"
                            onClick={() => { const q = `Intro paths to ${selected.label}`; setQuestion(q); ask(q); }}
                            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
                          >
                            <HiOutlineSparkles style={{ width: 13, height: 13 }} /> Find intro paths to {selected.label}
                          </button>
                        </>
                      )}
                      {graph.large && expanded.has(selected.key) && selected.count > MAX_PEOPLE_PER_EXPANDED_COMPANY && (
                        <p className="muted mt-1 text-xs">The graph draws the first {fmt(MAX_PEOPLE_PER_EXPANDED_COMPANY)} people by name; all {fmt(selected.count)} are listed here.</p>
                      )}
                      <ul className="mt-3 max-h-64 divide-y divide-line overflow-y-auto">
                        {selectedCompanyPeople.map((c) => (
                          <li key={dedupeKey(c)} className="py-1.5">
                            <button type="button" className="text-left hover:text-brand-600" onClick={() => selectContact({ ...c, key: dedupeKey(c) })}>
                              <span className="font-medium text-ink">{c.name}</span>
                              {c.position && <span className="block text-xs text-muted">{c.position}</span>}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </aside>
              </div>
            </>
          )}
        </section>

        {/* ---------------------------------------------------- ask */}
        <section className="card card-pad" aria-labelledby="ask-heading">
          <h2 id="ask-heading" className="section-title">Ask your network</h2>
          <p className="muted mt-1">Search by company, role, industry or place. Intro paths also check the company&apos;s investors from public sources.</p>
          <form
            onSubmit={(e) => { e.preventDefault(); ask(); }}
            className="mt-4 flex flex-col gap-2 sm:flex-row"
          >
            <div className="relative flex-1">
              <HiOutlineMagnifyingGlass className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" style={{ width: 17, height: 17 }} />
              <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Search your network..."
                aria-label="Ask your network"
                maxLength={500}
                className="input py-3 pl-10"
              />
            </div>
            <button
              type="submit"
              disabled={asking || !question.trim() || !contacts.length}
              className="btn-primary sm:px-5"
            >
              <HiOutlineSparkles style={ICON} /> {asking ? 'Searching…' : 'Ask'}
            </button>
          </form>
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                disabled={asking || !contacts.length}
                onClick={() => askExample(ex)}
                className="chip hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700 disabled:opacity-50"
              >
                {ex}
              </button>
            ))}
          </div>
          <p className="muted mt-3 text-xs">Your contacts never leave this app. Only the text of your question may be sent to the AI model when the built-in rules cannot interpret it.</p>
          {!contacts.length && mode !== 'loading' && (
            <p className="muted mt-3">Import your contacts above to start asking.</p>
          )}
          {askError && <p role="alert" className="mt-3 text-sm text-rose-600">{askError}</p>}

          {asking && (
            <div className="mt-4" aria-busy="true" aria-live="polite">
              <p className="flex items-center gap-2 text-sm text-ink">
                <HiOutlineSparkles className="text-brand-500 animate-glow" style={{ width: 16, height: 16 }} />
                {/intro|path/i.test(question) ? 'Searching your contacts and looking up the company\'s investors…' : 'Searching your contacts…'}
              </p>
              <div className="mt-3 space-y-2">
                <div className="skeleton h-4 w-1/3" />
                <div className="skeleton h-3 w-2/3" />
                <div className="skeleton h-4 w-1/4" />
                <div className="skeleton h-3 w-1/2" />
              </div>
            </div>
          )}

          {answer && !asking && (
            <div className="mt-4 border-t border-line pt-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-slate-700">
                  {answer.intent === 'intro-path'
                    ? <>Intro paths to <span className="font-semibold text-ink">{answer.intro?.target}</span></>
                    : <><span className="font-semibold text-ink">{fmt(answer.total)}</span> {answer.total === 1 ? 'match' : 'matches'}{answer.total > answer.results.length ? ` (top ${answer.results.length} shown)` : ''}</>}
                </div>
                <button type="button" onClick={() => setAnswer(null)} className="btn-ghost text-xs">Clear results</button>
              </div>
              {filtersShown && (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {filtersShown.companies.map((v) => <span key={`c${v}`} className="chip">Company: {v}</span>)}
                  {filtersShown.roles.map((v) => <span key={`r${v}`} className="chip">Role: {v}</span>)}
                  {filtersShown.keywords.map((v) => <span key={`k${v}`} className="chip">Keyword: {v}</span>)}
                  {filtersShown.locations.map((v) => <span key={`l${v}`} className="chip">Location: {v}</span>)}
                  {answer.parsedBy === 'llm' && <span className="chip chip-active"><HiOutlineSparkles style={{ width: 12, height: 12 }} /> question interpreted by AI (your contacts were not shared)</span>}
                </div>
              )}
              {(answer.notes || []).filter((n) => !/^Past employees/.test(n)).map((n) => (
                <p key={n} className="mb-2 text-xs text-amber-700">{n}</p>
              ))}

              {answer.intent === 'intro-path' && answer.intro ? (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-sm font-semibold text-ink">Direct: people at {answer.intro.target} <span className="chip ml-1">{answer.intro.direct.length}</span></h3>
                    {answer.intro.direct.length ? (
                      <ul className="divide-y divide-line">{answer.intro.direct.map((r) => <ResultRow key={r.contact.key} item={r} onShow={selectContact} />)}</ul>
                    ) : (
                      <p className="muted mt-1">No one in your network lists {answer.intro.target} as their company.</p>
                    )}
                  </div>
                  {answer.intro.possiblyRelated?.length > 0 && (
                    <div>
                      <h3 className="text-sm font-semibold text-ink">Possibly related <span className="chip ml-1">{answer.intro.possiblyRelated.length}</span></h3>
                      <p className="muted text-xs">Similar company names, or {answer.intro.target} mentioned in a title. They may not work there.</p>
                      <ul className="divide-y divide-line">{answer.intro.possiblyRelated.map((r) => <ResultRow key={`rel-${r.contact.key}`} item={r} onShow={selectContact} />)}</ul>
                    </div>
                  )}
                  <div>
                    <h3 className="text-sm font-semibold text-ink">Via investors <span className="chip ml-1">{answer.intro.viaInvestors.reduce((n, g) => n + g.total, 0)}</span></h3>
                    {answer.intro.viaInvestors.length ? answer.intro.viaInvestors.map((g) => (
                      <div key={g.investor} className="mt-2 border-l-2 border-brand-200 pl-3">
                        <div className="text-sm font-medium text-slate-700">{g.investor} <span className="text-xs font-normal text-muted">({g.evidence}; {g.total} {g.total === 1 ? 'contact' : 'contacts'})</span></div>
                        <ul className="divide-y divide-line">{g.contacts.map((r) => <ResultRow key={`${g.investor}-${r.contact.key}`} item={r} onShow={selectContact} />)}</ul>
                      </div>
                    )) : (
                      <p className="muted mt-1">
                        {answer.intro.investorsChecked.length
                          ? `You don't know anyone at the investors found for ${answer.intro.target} (${answer.intro.investorsChecked.slice(0, 8).join(', ')}${answer.intro.investorsChecked.length > 8 ? '…' : ''}).`
                          : 'No investor paths found.'}
                      </p>
                    )}
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-ink">Via past employees</h3>
                    <p className="muted mt-1">Not available: LinkedIn&apos;s export and contact files only include current company, not employment history.</p>
                  </div>
                </div>
              ) : (
                <>
                  {answer.results.length ? (
                    <ul className="divide-y divide-line">{answer.results.map((r) => <ResultRow key={r.contact.key} item={r} onShow={selectContact} />)}</ul>
                  ) : (
                    <p className="muted">No one in your network matches that. Try a company name, a role like &quot;engineers&quot;, or an industry like &quot;fintech&quot;.</p>
                  )}
                  {answer.possiblyRelated?.results?.length > 0 && (
                    <div className="mt-4">
                      <h3 className="text-sm font-semibold text-ink">Possibly related <span className="chip ml-1">{fmt(answer.possiblyRelated.total)}</span></h3>
                      <p className="muted text-xs">Similar company names, or the company mentioned in a title. They may not work there.</p>
                      <ul className="divide-y divide-line">{answer.possiblyRelated.results.map((r) => <ResultRow key={`rel-${r.contact.key}`} item={r} onShow={selectContact} />)}</ul>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </PageShell>
  );
}
