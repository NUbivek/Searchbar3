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
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from 'next-auth/react';
import { Tab } from '@headlessui/react';
import {
  FaSearch, FaProjectDiagram, FaUserTie, FaLinkedin, FaFileUpload, FaTrash, FaTimes, FaExternalLinkAlt,
} from 'react-icons/fa';
import { FaXTwitter } from 'react-icons/fa6';
import AccountMenu from '../components/account/AccountMenu';
import NetworkGraph, { SOURCE_COLORS } from '../components/network/NetworkGraph';
import {
  parseContactsFile, parseXFollowing, dedupeContacts, countBySource, dedupeKey, normalizeCompanyKey, MAX_CONTACTS,
} from '../utils/network/parseContacts';
import { buildGraph, personNodeId, companyNodeId, NO_COMPANY_KEY } from '../utils/network/graph';

function classNames(...classes) {
  return classes.filter(Boolean).join(' ');
}

const SOURCE_LABELS = { linkedin: 'LinkedIn', csv: 'CSV/XLSX', x: 'X' };
const EXAMPLES = ['Who do I know at Google?', 'Find software engineers in my network', 'Intro paths to Stripe'];
const MAX_FILE_BYTES = 25 * 1024 * 1024;

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

function SourceBadge({ source }) {
  return (
    <span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded border border-gray-200 text-gray-600">
      <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: SOURCE_COLORS[source] || SOURCE_COLORS.csv }} />
      {SOURCE_LABELS[source] || source}
    </span>
  );
}

function ContactActions({ name, company }) {
  if (!company && !name) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {company && (
        <>
          <Link href={`/company/${encodeURIComponent(company)}`} className="text-xs bg-blue-500 hover:bg-blue-600 text-white px-2.5 py-1.5 rounded-md">Company profile</Link>
          <Link href={`/?q=${encodeURIComponent(company)}`} className="text-xs bg-white border border-blue-200 text-blue-700 hover:bg-blue-50 px-2.5 py-1.5 rounded-md">Search company</Link>
        </>
      )}
      {name && (
        <Link
          href={`/founder?name=${encodeURIComponent(name)}${company ? `&company=${encodeURIComponent(company)}` : ''}`}
          className="text-xs bg-white border border-blue-200 text-blue-700 hover:bg-blue-50 px-2.5 py-1.5 rounded-md"
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
    <li className="py-2.5 border-b border-gray-100 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button type="button" onClick={() => onShow(c)} className="font-medium text-gray-900 hover:text-blue-700 text-left">{c.name}</button>
          <div className="text-sm text-gray-600 truncate">{[c.position, c.company].filter(Boolean).join(' · ') || 'No title or company listed'}</div>
          <ul className="mt-1 text-xs text-gray-500 list-disc list-inside">
            {item.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <SourceBadge source={c.source} />
          {c.profileUrl && (
            <a href={c.profileUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-xs text-blue-600 hover:underline inline-flex items-center">
              Profile <FaExternalLinkAlt className="ml-1" size={9} />
            </a>
          )}
        </div>
      </div>
    </li>
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

  const [linkedin, setLinkedin] = useState({ checked: false, connected: false, name: '' });
  const [xStatus, setXStatus] = useState({ checked: false, connected: false, username: '', note: '' });

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
      setLinkedin({ checked: true, connected: Boolean(d.isAuthenticated), name });
    } catch {
      setLinkedin({ checked: true, connected: false, name: '' });
    }
    try {
      const r = await fetch('/api/auth/twitter/token');
      const d = await readJson(r);
      if (r.status === 429) {
        setXStatus({ checked: true, connected: false, username: '', note: 'X status is temporarily unavailable (rate limited).' });
      } else {
        setXStatus({ checked: true, connected: Boolean(d.authenticated), username: d.profile?.username || '', note: '' });
      }
    } catch {
      setXStatus({ checked: true, connected: false, username: '', note: '' });
    }
  }, []);

  useEffect(() => { checkSocial(); }, [checkSocial]);

  // OAuth callbacks come back as ?auth=linkedin_success / ?error=...
  useEffect(() => {
    if (!router.isReady) return;
    const { error, auth } = router.query;
    if (!error && !auth) return;
    if (error) setNotice({ kind: 'error', text: String(error) });
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

  const saveSource = async (source, list) => {
    const deduped = dedupeContacts(list).slice(0, MAX_CONTACTS);
    if (mode === 'saved') {
      const response = await fetch('/api/network/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, contacts: deduped }),
      });
      const data = await readJson(response);
      if (response.status !== 503) {
        if (!response.ok) throw new Error(data.error || `Import failed (${response.status})`);
        await loadSaved();
        const extra = [
          data.duplicates ? `${data.duplicates.toLocaleString('en-US')} already saved from another source` : '',
          data.truncated ? `${data.truncated.toLocaleString('en-US')} over the ${MAX_CONTACTS.toLocaleString('en-US')} limit` : '',
        ].filter(Boolean).join('; ');
        return `Saved ${Number(data.saved || 0).toLocaleString('en-US')} ${SOURCE_LABELS[source]} contacts to your account${extra ? ` (${extra})` : ''}.`;
      }
      setMode('memory');
      setLoadError('Saving is not available right now (no database is configured), so your network is kept in this tab only.');
    }
    setContacts((prev) => dedupeContacts([...prev.filter((c) => c.source !== source), ...deduped]).slice(0, MAX_CONTACTS));
    setMemoryImports((prev) => ({ ...prev, [source]: new Date().toISOString() }));
    return `Loaded ${deduped.length.toLocaleString('en-US')} ${SOURCE_LABELS[source]} contacts into this tab.`;
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
        setNotice({
          kind: 'error',
          text: kind === 'linkedin'
            ? 'This does not look like LinkedIn\'s Connections.csv: no header row with First Name, Last Name, Company, Position and Connected On was found.'
            : 'No contacts found: the file needs a header row with a name column (Name, or First Name and Last Name) and ideally Company and Title.',
        });
        return;
      }
      if (!parsed.contacts.length) {
        setNotice({ kind: 'error', text: 'The file has a header row but no contacts with a name.' });
        return;
      }
      const message = await saveSource(parsed.source, parsed.contacts);
      const skipped = parsed.skippedRows ? ` ${parsed.skippedRows.toLocaleString('en-US')} rows without a name were skipped.` : '';
      setNotice({ kind: 'success', text: `${message}${skipped}` });
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
      const message = await saveSource('x', parsed.contacts);
      setNotice({ kind: 'success', text: `${message}${data.note ? ` ${data.note}` : ''}` });
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
    if (service === 'linkedin') setLinkedin({ checked: true, connected: false, name: '' });
    else setXStatus({ checked: true, connected: false, username: '', note: '' });
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

  const highlightedPeople = useMemo(() => {
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
        body.contacts = contacts.map((c) => ({
          name: c.name, company: c.company, position: c.position, location: c.location,
          profileUrl: c.profileUrl, email: c.email, connectedOn: c.connectedOn, source: c.source, tags: c.tags,
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
        const keys = new Set(expanded);
        [...(data.results || []), ...((data.intro?.viaInvestors || []).flatMap((g) => g.contacts))]
          .slice(0, 30)
          .forEach((r) => keys.add(normalizeCompanyKey(r.contact.company) || NO_COMPANY_KEY));
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

  return (
    <div className="w-full min-h-screen bg-gray-50">
      <Head>
        <title>Network Map - Research Hub</title>
        <meta name="description" content="Map and search your own professional network" />
      </Head>

      <main className="container mx-auto px-4 py-6">
        <div className="flex justify-end mb-2"><AccountMenu /></div>
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-gray-800">Research Hub</h1>
          <p className="text-gray-600 mt-1">Search across web, academic sources, and more.</p>
        </div>

        <Tab.Group>
          <Tab.List className="flex space-x-2 rounded-xl bg-blue-100 p-1 mb-6 max-w-xl mx-auto">
            <Link href="/" className="w-full rounded-lg py-2.5 text-sm font-medium leading-5 flex items-center justify-center bg-blue-100 text-blue-500 hover:bg-white/[0.12] hover:text-blue-700">
              <FaSearch className="mr-2" /> Open Research
            </Link>
            <Tab
              className={({ selected: isSelected }) =>
                classNames(
                  'w-full rounded-lg py-2.5 text-sm font-medium leading-5 flex items-center justify-center',
                  'focus:outline-none focus:ring-2 ring-offset-2 ring-offset-blue-400 ring-white ring-opacity-60',
                  isSelected
                    ? 'bg-white text-blue-700 shadow'
                    : 'text-blue-500 hover:bg-white/[0.12] hover:text-blue-700'
                )
              }
            >
              <FaProjectDiagram className="mr-2" /> Network Map
            </Tab>
            <Link href="/founder" className="w-full rounded-lg py-2.5 text-sm font-medium leading-5 flex items-center justify-center bg-blue-100 text-blue-500 hover:bg-white/[0.12] hover:text-blue-700">
              <FaUserTie className="mr-2" /> Founder Check
            </Link>
          </Tab.List>
        </Tab.Group>

        <div className="max-w-6xl mx-auto space-y-6">
          {notice && (
            <div
              role={notice.kind === 'error' ? 'alert' : 'status'}
              className={classNames(
                'p-3 text-sm rounded-lg border flex items-start justify-between gap-3',
                notice.kind === 'error' && 'bg-red-50 border-red-200 text-red-700',
                notice.kind === 'success' && 'bg-green-50 border-green-200 text-green-800',
                notice.kind === 'info' && 'bg-blue-50 border-blue-200 text-blue-800'
              )}
            >
              <span>{notice.text}</span>
              <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100"><FaTimes /></button>
            </div>
          )}

          {/* ---------------------------------------------------- import */}
          <section className="bg-white border border-gray-200 rounded-lg p-4" aria-labelledby="import-heading">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
              <div>
                <h2 id="import-heading" className="text-lg font-semibold text-gray-800">Your network</h2>
                <p className="text-sm text-gray-600">
                  Import your own contacts. Only your first-degree connections are in these files; nothing else is added.
                </p>
              </div>
              <div className="text-right text-sm">
                {mode === 'loading' ? (
                  <span className="text-gray-500">Loading your network…</span>
                ) : (
                  <>
                    <div className="font-medium text-gray-800">{contacts.length.toLocaleString('en-US')} contacts</div>
                    <div className="text-xs text-gray-500">
                      {mode === 'saved' ? 'Saved to your account' : 'Kept in this tab only'}
                      {lastImportAny ? ` · last import ${formatTime(lastImportAny)}` : ''}
                    </div>
                  </>
                )}
              </div>
            </div>

            {mode === 'memory' && !signedIn && sessionStatus !== 'loading' && (
              <div className="mb-3 p-2.5 text-sm rounded-md bg-amber-50 border border-amber-200 text-amber-800">
                <Link href="/signin" className="font-medium underline">Sign in to save your network</Link>. Until then, imports stay in this browser tab and are gone when you close it.
              </div>
            )}
            {loadError && (
              <div className="mb-3 p-2.5 text-sm rounded-md bg-amber-50 border border-amber-200 text-amber-800">{loadError}</div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <div className="border border-gray-200 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-medium text-gray-800 flex items-center"><FaLinkedin className="mr-2 text-[#0077B5]" /> LinkedIn connections</h3>
                  <span className="text-xs text-gray-500">{counts.linkedin.toLocaleString('en-US')}{lastImport('linkedin') ? ` · ${formatTime(lastImport('linkedin'))}` : ''}</span>
                </div>
                <ol className="text-xs text-gray-600 list-decimal list-inside space-y-0.5 mb-3">
                  <li>On LinkedIn, open <span className="font-medium">Settings &amp; Privacy → Data privacy → Get a copy of your data</span>.</li>
                  <li>Choose <span className="font-medium">Connections</span> (or the full archive) and request the archive.</li>
                  <li>LinkedIn emails a download link, usually within minutes. Unzip it.</li>
                  <li>Upload <span className="font-medium">Connections.csv</span> here.</li>
                </ol>
                <input ref={linkedinInput} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => handleFile(e, 'linkedin')} data-testid="linkedin-file" />
                <button
                  type="button"
                  onClick={() => linkedinInput.current?.click()}
                  disabled={Boolean(busy) || mode === 'loading'}
                  className="inline-flex items-center bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white text-sm px-3 py-2 rounded-md"
                >
                  <FaFileUpload className="mr-2" /> {busy === 'linkedin' ? 'Importing…' : 'Upload LinkedIn Connections.csv'}
                </button>
                <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-600">
                  {linkedin.connected ? (
                    <div className="flex items-center justify-between gap-2">
                      <span>Connected as <span className="font-medium">{linkedin.name || 'your LinkedIn profile'}</span> (profile only).</span>
                      <button type="button" onClick={() => disconnect('linkedin')} className="text-blue-600 hover:underline">Disconnect</button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <span>Signing in with LinkedIn only shares your own profile: LinkedIn does not give apps your connections, so use the export above.</span>
                      <a href="/api/auth/linkedin" className="shrink-0 text-blue-600 hover:underline">Connect profile</a>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-4">
                <div className="border border-gray-200 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-medium text-gray-800 flex items-center"><FaFileUpload className="mr-2 text-gray-500" /> Other contacts (CSV / XLSX)</h3>
                    <span className="text-xs text-gray-500">{counts.csv.toLocaleString('en-US')}{lastImport('csv') ? ` · ${formatTime(lastImport('csv'))}` : ''}</span>
                  </div>
                  <p className="text-xs text-gray-600 mb-3">
                    Any spreadsheet with a header row: Name (or First/Last Name), Company, Title, Email, LinkedIn URL, Location, Tags. A new upload replaces your previous CSV/XLSX import.
                  </p>
                  <input ref={genericInput} type="file" accept=".csv,.tsv,.xlsx,.xls,.json,text/csv,application/json" className="hidden" onChange={(e) => handleFile(e, 'auto')} data-testid="generic-file" />
                  <button
                    type="button"
                    onClick={() => genericInput.current?.click()}
                    disabled={Boolean(busy) || mode === 'loading'}
                    className="inline-flex items-center bg-white border border-blue-300 text-blue-700 hover:bg-blue-50 disabled:opacity-50 text-sm px-3 py-2 rounded-md"
                  >
                    <FaFileUpload className="mr-2" /> {busy === 'auto' ? 'Importing…' : 'Upload CSV/XLSX contacts'}
                  </button>
                </div>

                <div className="border border-gray-200 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-medium text-gray-800 flex items-center"><FaXTwitter className="mr-2" /> X following (optional)</h3>
                    <span className="text-xs text-gray-500">{counts.x.toLocaleString('en-US')}{lastImport('x') ? ` · ${formatTime(lastImport('x'))}` : ''}</span>
                  </div>
                  {xStatus.connected ? (
                    <>
                      <p className="text-xs text-gray-600 mb-2">Connected as <span className="font-medium">@{xStatus.username || 'unknown'}</span>. Importing who you follow needs a paid X API tier; if this app does not have it, you will see a note instead.</p>
                      <div className="flex items-center gap-3">
                        <button type="button" onClick={importX} disabled={Boolean(busy)} className="inline-flex items-center bg-black hover:bg-gray-800 disabled:opacity-50 text-white text-sm px-3 py-2 rounded-md">
                          {busy === 'x' ? 'Importing…' : 'Import accounts I follow'}
                        </button>
                        <button type="button" onClick={() => disconnect('twitter')} className="text-xs text-blue-600 hover:underline">Disconnect</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-xs text-gray-600 mb-2">X only shares following lists with apps on a paid API tier, so this may not be available. You can also upload an X API following JSON file above.</p>
                      <a href="/api/auth/twitter" className="inline-flex items-center bg-white border border-gray-300 text-gray-800 hover:bg-gray-50 text-sm px-3 py-2 rounded-md">
                        <FaXTwitter className="mr-2" /> Connect X
                      </a>
                    </>
                  )}
                  {xStatus.note && <p className="text-xs text-amber-700 mt-2">{xStatus.note}</p>}
                </div>
              </div>
            </div>

            {contacts.length > 0 && (
              <div className="mt-4 pt-3 border-t border-gray-100 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
                <span>
                  Your contacts are only used to answer your own questions. They are never sent to AI models or other services.
                </span>
                <button type="button" onClick={removeAll} disabled={Boolean(busy)} className="inline-flex items-center text-red-600 hover:text-red-700 disabled:opacity-50">
                  <FaTrash className="mr-1" /> {busy === 'delete' ? 'Removing…' : 'Remove all my network data'}
                </button>
              </div>
            )}
          </section>

          {/* ---------------------------------------------------- graph */}
          <section className="bg-white border border-gray-200 rounded-lg p-4" aria-labelledby="graph-heading">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <h2 id="graph-heading" className="text-lg font-semibold text-gray-800">Network graph</h2>
              {contacts.length > 0 && (
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  {['linkedin', 'csv', 'x'].map((s) => (
                    <label key={s} className={classNames('inline-flex items-center gap-1.5', !counts[s] && 'opacity-50')}>
                      <input
                        type="checkbox"
                        className="rounded border-gray-300"
                        checked={sourceFilter[s]}
                        disabled={!counts[s]}
                        onChange={(e) => setSourceFilter((f) => ({ ...f, [s]: e.target.checked }))}
                      />
                      <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: SOURCE_COLORS[s] }} />
                      {SOURCE_LABELS[s]} ({counts[s].toLocaleString('en-US')})
                    </label>
                  ))}
                </div>
              )}
            </div>

            {contacts.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-16 text-gray-500">
                <FaProjectDiagram className="text-5xl text-blue-300 mb-3" />
                <p className="font-medium text-gray-700">{mode === 'loading' ? 'Loading your network…' : 'No contacts yet'}</p>
                {mode !== 'loading' && <p className="text-sm mt-1 max-w-md">Upload LinkedIn&apos;s Connections.csv or a contacts spreadsheet above to see who you know, grouped by company.</p>}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2 mb-3">
                  <input
                    type="search"
                    value={companyFilter}
                    onChange={(e) => { setCompanyFilter(e.target.value); setSelected(null); }}
                    placeholder="Filter by company…"
                    aria-label="Filter by company"
                    className="flex-1 min-w-[180px] h-9 px-3 text-sm border border-gray-200 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-300"
                  />
                  <input
                    type="search"
                    value={graphSearch}
                    onChange={(e) => setGraphSearch(e.target.value)}
                    placeholder="Highlight a name, title or company…"
                    aria-label="Highlight in graph"
                    className="flex-1 min-w-[180px] h-9 px-3 text-sm border border-gray-200 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-300"
                  />
                </div>
                <div className="text-xs text-gray-500 mb-2 flex flex-wrap gap-x-4 gap-y-1">
                  <span>{visibleContacts.length.toLocaleString('en-US')} people · {graph.companyCount.toLocaleString('en-US')} companies</span>
                  {graph.large && (
                    <span>
                      Large network: showing companies only{graph.hiddenCompanies ? ` (largest ${(graph.companyCount - graph.hiddenCompanies).toLocaleString('en-US')}; filter to find others)` : ''}. Click a company to show its people.
                    </span>
                  )}
                  {(graphSearch.trim() || answerKeys) && <span>{highlightedPeople.toLocaleString('en-US')} highlighted{graph.large ? ' (in expanded companies)' : ''}</span>}
                </div>

                <div className="flex flex-col lg:flex-row gap-4">
                  <div ref={graphBoxRef} className="flex-1 min-w-0 border border-gray-200 rounded-md overflow-hidden">
                    {visibleContacts.length === 0 ? (
                      <div className="flex items-center justify-center text-sm text-gray-500" style={{ height: 560 }}>No contacts match these filters.</div>
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

                  <aside className="lg:w-80 shrink-0 border border-gray-200 rounded-md p-3 text-sm" aria-label="Details">
                    {!selected && (
                      <div className="text-gray-500">
                        <p className="font-medium text-gray-700 mb-1">Details</p>
                        <p>Click a person or company in the graph to see details. Blue circles are companies, sized by how many people you know there.</p>
                      </div>
                    )}
                    {selected?.type === 'person' && (
                      <div>
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="font-semibold text-gray-900">{selected.contact.name}</h3>
                          <button type="button" onClick={() => setSelected(null)} aria-label="Close details" className="text-gray-400 hover:text-gray-600"><FaTimes /></button>
                        </div>
                        {selected.contact.position && <p className="text-gray-700">{selected.contact.position}</p>}
                        {selected.contact.company && <p className="text-gray-600">{selected.contact.company}</p>}
                        <dl className="mt-2 space-y-1 text-xs text-gray-600">
                          {selected.contact.location && <div><dt className="inline font-medium">Location: </dt><dd className="inline">{selected.contact.location}</dd></div>}
                          {selected.contact.connectedOn && <div><dt className="inline font-medium">Connected on: </dt><dd className="inline">{formatDate(selected.contact.connectedOn)}</dd></div>}
                          {selected.contact.email && <div><dt className="inline font-medium">Email: </dt><dd className="inline break-all">{selected.contact.email}</dd></div>}
                          <div><dt className="inline font-medium">Source: </dt><dd className="inline"><SourceBadge source={selected.contact.source} /></dd></div>
                          {selected.contact.tags?.length > 0 && <div><dt className="inline font-medium">Tags: </dt><dd className="inline">{selected.contact.tags.join(', ')}</dd></div>}
                        </dl>
                        {selected.contact.profileUrl && (
                          <a href={selected.contact.profileUrl} target="_blank" rel="noopener noreferrer nofollow" className="mt-2 inline-flex items-center text-blue-600 hover:underline text-xs">
                            Open profile <FaExternalLinkAlt className="ml-1" size={9} />
                          </a>
                        )}
                        <ContactActions name={selected.contact.name} company={selected.contact.company} />
                      </div>
                    )}
                    {selected?.type === 'company' && (
                      <div>
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="font-semibold text-gray-900">{selected.label}</h3>
                          <button type="button" onClick={() => setSelected(null)} aria-label="Close details" className="text-gray-400 hover:text-gray-600"><FaTimes /></button>
                        </div>
                        <p className="text-gray-600">{selected.count} {selected.count === 1 ? 'person' : 'people'} you know</p>
                        {graph.large && expanded.has(selected.key) && (
                          <button
                            type="button"
                            onClick={() => setExpanded((prev) => { const next = new Set(prev); next.delete(selected.key); return next; })}
                            className="mt-1 text-xs text-gray-500 hover:text-gray-700 underline"
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
                              className="mt-2 text-xs text-blue-600 hover:underline"
                            >
                              Find intro paths to {selected.label}
                            </button>
                          </>
                        )}
                        <ul className="mt-3 max-h-64 overflow-y-auto divide-y divide-gray-100">
                          {selectedCompanyPeople.slice(0, 200).map((c) => (
                            <li key={dedupeKey(c)} className="py-1.5">
                              <button type="button" className="text-left hover:text-blue-700" onClick={() => selectContact({ ...c, key: dedupeKey(c) })}>
                                <span className="font-medium">{c.name}</span>
                                {c.position && <span className="block text-xs text-gray-500">{c.position}</span>}
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
          <section className="bg-white border border-gray-200 rounded-lg p-4" aria-labelledby="ask-heading">
            <h2 id="ask-heading" className="text-lg font-semibold text-gray-800 mb-1">Ask your network</h2>
            <p className="text-sm text-gray-600 mb-3">Search by company, role, industry or place. Intro paths also check the company&apos;s investors from public sources.</p>
            <form
              onSubmit={(e) => { e.preventDefault(); ask(); }}
              className="flex gap-2"
            >
              <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Search your network..."
                aria-label="Ask your network"
                maxLength={500}
                className="flex-1 h-11 px-4 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-300 shadow-sm"
              />
              <button
                type="submit"
                disabled={asking || !question.trim() || !contacts.length}
                className="inline-flex items-center bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white text-sm px-4 rounded-lg"
              >
                <FaSearch className="mr-2" /> {asking ? 'Searching…' : 'Ask'}
              </button>
            </form>
            <div className="flex flex-wrap gap-2 mt-3">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  disabled={asking || !contacts.length}
                  onClick={() => askExample(ex)}
                  className="text-xs bg-blue-50 border border-blue-100 text-blue-800 hover:bg-blue-100 disabled:opacity-50 px-3 py-1.5 rounded-full"
                >
                  {ex}
                </button>
              ))}
            </div>
            {!contacts.length && mode !== 'loading' && (
              <p className="text-sm text-gray-500 mt-3">Import your contacts above to start asking.</p>
            )}
            {askError && <p role="alert" className="mt-3 text-sm text-red-600">{askError}</p>}

            {asking && (
              <div className="mt-4 flex items-center text-sm text-gray-600">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-500 mr-2" />
                {/intro|path/i.test(question) ? 'Searching your contacts and looking up the company\'s investors…' : 'Searching your contacts…'}
              </div>
            )}

            {answer && !asking && (
              <div className="mt-4">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div className="text-sm text-gray-700">
                    {answer.intent === 'intro-path'
                      ? <>Intro paths to <span className="font-semibold">{answer.intro?.target}</span></>
                      : <><span className="font-semibold">{answer.total.toLocaleString('en-US')}</span> {answer.total === 1 ? 'match' : 'matches'}{answer.total > answer.results.length ? ` (top ${answer.results.length} shown)` : ''}</>}
                  </div>
                  <button type="button" onClick={() => setAnswer(null)} className="text-xs text-gray-500 hover:text-gray-700">Clear results</button>
                </div>
                {filtersShown && (
                  <div className="flex flex-wrap gap-1.5 mb-3 text-xs">
                    {filtersShown.companies.map((v) => <span key={`c${v}`} className="px-2 py-0.5 rounded bg-gray-100 text-gray-700">Company: {v}</span>)}
                    {filtersShown.roles.map((v) => <span key={`r${v}`} className="px-2 py-0.5 rounded bg-gray-100 text-gray-700">Role: {v}</span>)}
                    {filtersShown.keywords.map((v) => <span key={`k${v}`} className="px-2 py-0.5 rounded bg-gray-100 text-gray-700">Keyword: {v}</span>)}
                    {filtersShown.locations.map((v) => <span key={`l${v}`} className="px-2 py-0.5 rounded bg-gray-100 text-gray-700">Location: {v}</span>)}
                    {answer.parsedBy === 'llm' && <span className="px-2 py-0.5 rounded bg-purple-50 text-purple-700">question interpreted by AI (your contacts were not shared)</span>}
                  </div>
                )}
                {(answer.notes || []).filter((n) => !/^Past employees/.test(n)).map((n) => (
                  <p key={n} className="text-xs text-amber-700 mb-2">{n}</p>
                ))}

                {answer.intent === 'intro-path' && answer.intro ? (
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-800">Direct: people at {answer.intro.target} ({answer.intro.direct.length})</h3>
                      {answer.intro.direct.length ? (
                        <ul>{answer.intro.direct.map((r) => <ResultRow key={r.contact.key} item={r} onShow={selectContact} />)}</ul>
                      ) : (
                        <p className="text-sm text-gray-500 mt-1">No one in your network lists {answer.intro.target} as their company.</p>
                      )}
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-gray-800">Via investors ({answer.intro.viaInvestors.reduce((n, g) => n + g.total, 0)})</h3>
                      {answer.intro.viaInvestors.length ? answer.intro.viaInvestors.map((g) => (
                        <div key={g.investor} className="mt-2 border-l-2 border-blue-200 pl-3">
                          <div className="text-sm font-medium text-gray-700">{g.investor} <span className="text-xs font-normal text-gray-500">({g.evidence}; {g.total} {g.total === 1 ? 'contact' : 'contacts'})</span></div>
                          <ul>{g.contacts.map((r) => <ResultRow key={`${g.investor}-${r.contact.key}`} item={r} onShow={selectContact} />)}</ul>
                        </div>
                      )) : (
                        <p className="text-sm text-gray-500 mt-1">
                          {answer.intro.investorsChecked.length
                            ? `You don't know anyone at the investors found for ${answer.intro.target} (${answer.intro.investorsChecked.slice(0, 8).join(', ')}${answer.intro.investorsChecked.length > 8 ? '…' : ''}).`
                            : 'No investor paths found.'}
                        </p>
                      )}
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-gray-800">Via past employees</h3>
                      <p className="text-sm text-gray-500 mt-1">Not available: LinkedIn&apos;s export and contact files only include current company, not employment history.</p>
                    </div>
                  </div>
                ) : answer.results.length ? (
                  <ul>{answer.results.map((r) => <ResultRow key={r.contact.key} item={r} onShow={selectContact} />)}</ul>
                ) : (
                  <p className="text-sm text-gray-500">No one in your network matches that. Try a company name, a role like &quot;engineers&quot;, or an industry like &quot;fintech&quot;.</p>
                )}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
