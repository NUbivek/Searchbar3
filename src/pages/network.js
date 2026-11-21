/**
 * Network Map: import your own contacts (LinkedIn's Connections.csv export,
 * any CSV/XLSX, or your X following list), read in plain words what the file
 * holds, and use shortcuts built from it to light people on the globe and
 * list them beside it. Ask questions like "Who do I know at Stripe?".
 *
 * Signed in: contacts are saved to your account (/api/network/contacts).
 * Signed out: contacts stay in this browser tab only.
 * Only first-degree connections exist in these exports; nothing is invented.
 *
 * One selection drives the page (spec section 2): a shortcut (or several,
 * combined), the Find box, an answer, or a click on the globe. It lights
 * people on the globe and fills the people panel; it never rebuilds the
 * globe's layout (only "Arrange by", the source chips and "direct only" do).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from 'next-auth/react';
import {
  HiOutlineShare, HiOutlineCloudArrowUp, HiOutlineArrowsPointingIn, HiOutlineArrowsPointingOut, HiOutlineXMark,
} from 'react-icons/hi2';
import PageShell from '../components/layout/PageShell';
import NetworkGraph, { SOURCE_COLORS } from '../components/network/NetworkGraph';
import AtAGlance from '../components/network/AtAGlance';
import PeoplePanel, { sortPeople } from '../components/network/PeoplePanel';
import SourceStrip from '../components/network/SourceStrip';
import Connectors, { X_UNAVAILABLE } from '../components/network/Connectors';
import { ChecksContext, contactNameCounts, checkHref, formatDate } from '../components/network/checks';
import {
  parseContactsFile, parseXFollowing, dedupeContacts, countBySource, dedupeKey, MAX_CONTACTS,
} from '../utils/network/parseContacts';
import { buildAtlas, pathTo, personNodeId, NO_COMPANY_KEY, ROOT_ID } from '../utils/network/atlas';
import { GROUPINGS } from '../utils/network/grouping';
import { profileNetwork, combine, countIfAdded } from '../utils/network/insights';
import { useTheme } from '../utils/theme';

// Kept where other pages and tests import them from.
export { findCheck, contactNameCounts, checkHref, checkChip } from '../components/network/checks';

function classNames(...classes) {
  return classes.filter(Boolean).join(' ');
}

const ICON = { width: 15, height: 15 };
const SOURCE_LABELS = { linkedin: 'LinkedIn', csv: 'CSV/XLSX', x: 'X', attio: 'Attio' };
const GROUPING_LABEL = Object.fromEntries(GROUPINGS.map((g) => [g.key, g.label]));
/** Height of the globe, and the most group rows the panel lists for the part in view. */
const GRAPH_HEIGHT = 620;
const MAX_GROUP_ROWS = 40;
/** Shortcuts that can be pressed at once. */
const MAX_CHIPS = 3;
const NO_IDS = new Set();
const MAX_FILE_BYTES = 25 * 1024 * 1024;
// The contacts API accepts 15 MB request bodies; stop a little short of it.
const MAX_BODY_BYTES = 14 * 1024 * 1024;
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const LINKEDIN_UNAVAILABLE = "LinkedIn connection isn't available on this deployment yet";
// Attio stays a placeholder until the firm's workspace access is set up (the import route and UI are ready).
const ATTIO_ENABLED = process.env.NEXT_PUBLIC_ATTIO_ENABLED === 'true';

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

async function readJson(response) {
  try { return await response.json(); } catch { return {}; }
}

export default function NetworkPage() {
  const router = useRouter();
  const { status: sessionStatus } = useSession();
  const signedIn = sessionStatus === 'authenticated';

  const [contacts, setContacts] = useState([]);
  const [mode, setMode] = useState('loading'); // loading | saved | memory
  const [stats, setStats] = useState(null);
  const [memoryImports, setMemoryImports] = useState({});
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(null); // { kind: 'error'|'success'|'info', text }
  const [busy, setBusy] = useState(null);

  const [xStatus, setXStatus] = useState({ checked: false, connected: false, username: '', note: '', configured: true });
  // Shown inline when a connection is offered but not available on this deployment.
  const [unavailable, setUnavailable] = useState({ x: false });

  const [sourceFilter, setSourceFilter] = useState({ linkedin: true, csv: true, x: true, attio: true });
  const [directOnly, setDirectOnly] = useState(false);
  // The arrangement the user picked; null follows the file's own default.
  const [groupChoice, setGroupChoice] = useState(null);
  // The map is one fixed layout; `focus` is where the camera was last sent
  // (the nonce re-triggers a flight to the same place) and `viewId` is the
  // bubble the viewer is inside right now, as reported by the map.
  const [focus, setFocus] = useState({ id: ROOT_ID, nonce: 0 });
  const [viewId, setViewId] = useState(ROOT_ID);
  const [theme] = useTheme();

  // ---- the one selection: at most one of these is set at a time.
  const [chipIds, setChipIds] = useState([]); // shortcuts pressed together
  const [findText, setFindText] = useState(''); // the panel's Find box (a selection from two characters)
  const [pick, setPick] = useState(null); // a click on the globe: { label, keys, sort, company, nodeId }
  const [answer, setAnswer] = useState(null); // an answer to a question
  const [openId, setOpenId] = useState(null); // the row opened in place in the panel

  const [dragging, setDragging] = useState(false);
  const [checks, setChecks] = useState([]); // founder checks this user has finished
  const [runningChecks, setRunningChecks] = useState([]); // and the ones still running
  useEffect(() => {
    if (sessionStatus !== 'authenticated') { setChecks([]); setRunningChecks([]); return undefined; }
    let live = true;
    fetch('/api/founder/history').then((r) => (r.ok ? r.json() : { checks: [] })).then((d) => {
      if (!live) return;
      setChecks(Array.isArray(d.checks) ? d.checks : []);
      setRunningChecks(Array.isArray(d.running) ? d.running : []);
    }).catch(() => {});
    return () => { live = false; };
  }, [sessionStatus]);

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState('');

  const graphBoxRef = useRef(null);
  const mapRef = useRef(null);
  const glanceRef = useRef(null);
  const [graphWidth, setGraphWidth] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [graphHeight, setGraphHeight] = useState(GRAPH_HEIGHT);
  const linkedinInput = useRef(null);
  const genericInput = useRef(null);
  // Set once the user has uploaded in this visit: the globe then settles at
  // once instead of swinging in, and the page scrolls to the read-out.
  const uploaded = useRef(false);
  const [scrollToGlance, setScrollToGlance] = useState(0);

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
      const r = await fetch('/api/auth/twitter/token');
      const d = await readJson(r);
      const configured = d.configured !== false;
      if (r.status === 429) {
        setXStatus({ checked: true, connected: false, username: '', note: 'X status is temporarily unavailable (too many requests). Try again in a few minutes.', configured });
      } else if (r.status === 403 && d.signedIn) {
        // Signed in at X, but X refuses to share data with this app.
        const why = /client-not-enrolled/i.test(d.xReason || '') || /attached to a Project/i.test(d.xDetail || '')
          ? 'X accepted the sign-in but will not share your follows: the X app must be attached to a Project in the X developer portal.'
          : `X accepted the sign-in but will not share your follows${d.xReason ? ` (${d.xReason})` : ''}. Check the app's Project and access level in the X developer portal.`;
        setXStatus({ checked: true, connected: false, username: '', note: why, configured });
      } else {
        setXStatus({ checked: true, connected: Boolean(d.authenticated), username: d.profile?.username || '', note: '', configured });
      }
    } catch {
      setXStatus({ checked: true, connected: false, username: '', note: '', configured: true });
    }
  }, []);

  // LinkedIn gives apps no connections, so the page offers its export and never asks for LinkedIn's sign-in status.
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

  const hasContacts = contacts.length > 0;

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
  }, [hasContacts]);

  // Full screen: the map section (globe, panel and toolbar) goes full screen;
  // the canvas follows the window height, less the toolbar, while it is.
  useEffect(() => {
    const onChange = () => {
      const on = Boolean(document.fullscreenElement) && document.fullscreenElement === mapRef.current;
      setFullscreen(on);
      setGraphHeight(on ? Math.max(320, window.innerHeight - 52) : GRAPH_HEIGHT);
    };
    const onResize = () => { if (document.fullscreenElement === mapRef.current) setGraphHeight(Math.max(320, window.innerHeight - 52)); };
    document.addEventListener('fullscreenchange', onChange);
    window.addEventListener('resize', onResize);
    return () => { document.removeEventListener('fullscreenchange', onChange); window.removeEventListener('resize', onResize); };
  }, []);
  const toggleFullscreen = () => {
    const el = mapRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.();
  };

  // ------------------------------------------------------------ selection

  const clearSelection = useCallback(() => {
    setChipIds([]);
    setFindText('');
    setPick(null);
    setAnswer(null);
    setOpenId(null);
  }, []);
  /** Fly the map to a bubble. */
  const goTo = useCallback((id) => { setViewId(id); setFocus((f) => ({ id, nonce: f.nonce + 1 })); }, []);

  // ------------------------------------------------------------ import

  /** A new file opens on its own default arrangement, with nothing selected, and the page shows its read-out. */
  const freshData = () => {
    uploaded.current = true;
    clearSelection();
    setGroupChoice(null);
    setViewId(ROOT_ID);
    setFocus((f) => ({ id: ROOT_ID, nonce: f.nonce + 1 }));
    setScrollToGlance((n) => n + 1);
  };

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

  const importFile = async (file, kind) => {
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
          text = 'This is a contacts file, not LinkedIn\'s Connections.csv (no First Name, Last Name and Connected On columns), so it was not imported. Use "Upload contacts" for it; your LinkedIn import is unchanged.';
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
      freshData();
    } catch (error) {
      setNotice({ kind: 'error', text: `Import failed: ${error.message}` });
    } finally {
      setBusy(null);
    }
  };

  const handleFile = async (event, kind) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    await importFile(file, kind);
  };

  // Drop a file onto the import area: LinkedIn's export is recognised by
  // its columns, anything else is read as a contacts file.
  const onDragOver = (event) => { event.preventDefault(); if (!dragging) setDragging(true); };
  const onDragLeave = (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); };
  const onDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    if (busy || mode === 'loading') return;
    importFile(event.dataTransfer?.files?.[0], 'auto');
  };
  const dropProps = { onDragOver, onDragLeave, onDrop };

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
      freshData();
    } catch (error) {
      setNotice({ kind: 'error', text: error.message });
    } finally {
      setBusy(null);
    }
  };

  /** Import from Attio with the access code pasted in Connectors; true when it worked. */
  const importAttio = async (token) => {
    if (!token) return false;
    setBusy('attio');
    setNotice(null);
    try {
      const response = await fetch('/api/network/attio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.error || `Attio import failed (${response.status})`);
      if (Array.isArray(data.contacts)) {
        setContacts((prev) => [...prev.filter((c) => c.source !== 'attio'), ...data.contacts]);
        if (data.stats) setStats(data.stats);
      } else {
        await loadSaved();
      }
      const parts = [
        `Imported ${fmt(data.saved)} people from Attio: ${fmt(data.direct)} your own connections, ${fmt(data.firm)} firm-wide contacts held by colleagues.`,
        data.duplicates ? `${fmt(data.duplicates)} were already in your network from another source.` : '',
        data.truncated ? 'The import stopped at the contact limit.' : '',
        data.note || '',
      ].filter(Boolean);
      setNotice({ kind: data.saved ? 'success' : 'info', text: parts.join(' ') });
      freshData();
      return true;
    } catch (error) {
      setNotice({ kind: 'error', text: error.message });
      return false;
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
    setXStatus((s) => ({ ...s, checked: true, connected: false, username: '', note: '' }));
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
      clearSelection();
      setGroupChoice(null);
      setViewId(ROOT_ID);
      setNotice({ kind: 'success', text: 'All of your network data was removed.' });
    } catch (error) {
      setNotice({ kind: 'error', text: error.message });
    } finally {
      setBusy(null);
    }
  };

  // ------------------------------------------------------------ the network

  const counts = useMemo(() => countBySource(contacts), [contacts]);
  const firmCount = useMemo(() => contacts.filter((c) => c.relationship === 'firm').length, [contacts]);

  // The people in view: only the source chips and "direct only" narrow them.
  const visibleContacts = useMemo(
    () => contacts.filter((c) => sourceFilter[c.source] !== false && !(directOnly && c.relationship === 'firm')),
    [contacts, sourceFilter, directOnly],
  );

  // What the file holds: the read-out, the shortcuts, the example questions
  // and the arrangements that split it. Depends only on the people in view.
  const profile = useMemo(() => profileNetwork(visibleContacts), [visibleContacts]);
  const groupings = profile.groupings || [];
  const groupBy = groupChoice && groupings.some((g) => g.key === groupChoice) ? groupChoice : profile.defaultGrouping || 'role';

  // The whole map is laid out once per arrangement or source change; a
  // selection only lights people and moves the camera.
  const atlas = useMemo(() => buildAtlas(visibleContacts, { groupBy }), [visibleContacts, groupBy]);

  /** person id -> contact, for the people in view. */
  const byPersonId = useMemo(() => {
    const m = new Map();
    for (const c of visibleContacts) m.set(personNodeId(c), c);
    return m;
  }, [visibleContacts]);

  // A check run without a company marks a contact only when that contact's full name is unique here.
  const checksContext = useMemo(() => ({ checks, running: runningChecks, nameCounts: contactNameCounts(contacts) }), [checks, runningChecks, contacts]);

  // An answer's people come back keyed by dedupeKey; map them onto the globe's ids.
  const byDedupe = useMemo(() => {
    if (!answer) return null;
    const m = new Map();
    for (const c of contacts) m.set(dedupeKey(c), c);
    return m;
  }, [answer, contacts]);
  const resolve = useCallback((contact) => {
    const full = (byDedupe && contact?.key && byDedupe.get(contact.key)) || contact;
    return { c: full, id: personNodeId(full) };
  }, [byDedupe]);

  // Signed in, the server searches every saved contact; the source chips and
  // "direct only" may hide some of them. Keep the answer to the people in
  // view so it never counts anyone the read-out and the globe leave out.
  const shownAnswer = useMemo(() => {
    if (!answer || visibleContacts.length === contacts.length) return answer;
    let hidden = 0;
    const keep = (list) => (list || []).filter((r) => {
      const ok = byPersonId.has(resolve(r.contact).id);
      if (!ok) hidden += 1;
      return ok;
    });
    const results = keep(answer.results);
    const intro = answer.intro ? {
      ...answer.intro,
      direct: keep(answer.intro.direct),
      possiblyRelated: keep(answer.intro.possiblyRelated),
      viaInvestors: (answer.intro.viaInvestors || [])
        .map((g) => { const kept = keep(g.contacts); return { ...g, contacts: kept, total: Math.max(kept.length, (g.total || 0) - (g.contacts.length - kept.length)) }; })
        .filter((g) => g.contacts.length),
    } : answer.intro;
    const possiblyRelated = answer.possiblyRelated
      ? { ...answer.possiblyRelated, results: keep(answer.possiblyRelated.results) } : answer.possiblyRelated;
    const removed = (answer.results || []).length - results.length;
    return {
      ...answer,
      results,
      intro,
      possiblyRelated,
      total: Math.max(results.length, (Number(answer.total) || 0) - removed),
      hiddenByFilters: hidden,
    };
  }, [answer, visibleContacts.length, contacts.length, byPersonId, resolve]);

  // Shortcut ids that still exist after the people in view changed.
  const liveChipIds = useMemo(() => {
    const known = new Set([...profile.shortcuts, ...profile.more].map((s) => s.id));
    return chipIds.filter((id) => known.has(id));
  }, [chipIds, profile]);

  // The one selection { label, keys: Set, sort, company?, nodeId? }, or null.
  // Its key Set is built once per selection, so the globe turns and pulses
  // only when the selection really changes.
  const term = findText.trim().toLowerCase();
  const selection = useMemo(() => {
    if (answer) {
      const keys = new Set();
      const add = (r) => { const id = resolve(r.contact).id; if (byPersonId.has(id)) keys.add(id); };
      (answer.results || []).forEach(add);
      (answer.intro?.direct || []).forEach(add);
      (answer.intro?.viaInvestors || []).forEach((g) => g.contacts.forEach(add));
      return { kind: 'answer', label: 'Answer', keys, sort: null };
    }
    if (pick) return pick;
    if (term.length >= 2) {
      // Most senior first, as everyone is listed.
      const keys = new Set(profile.everyone.keys.filter((id) => {
        const c = byPersonId.get(id);
        return c && [c.name, c.company, c.position].some((v) => String(v || '').toLowerCase().includes(term));
      }));
      return { kind: 'find', label: `Find “${findText.trim()}”`, keys, sort: 'senior' };
    }
    if (liveChipIds.length) {
      // One company chip is a company selection: the panel offers its profile and intro paths.
      const only = liveChipIds.length === 1 && liveChipIds[0].startsWith('company:')
        ? [...profile.shortcuts, ...profile.more].find((s) => s.id === liveChipIds[0]) : null;
      return { kind: 'chips', ...combine(profile, liveChipIds), company: only ? only.short.replace(/^at /, '') : '' };
    }
    return null;
  }, [answer, resolve, pick, term, findText, liveChipIds, profile, byPersonId]);
  const highlightIds = selection ? selection.keys : NO_IDS;

  const toggleChip = (id) => {
    setFindText('');
    setPick(null);
    setAnswer(null);
    setOpenId(null);
    setChipIds((prev) => {
      const live = prev.filter((x) => liveChipIds.includes(x));
      if (live.includes(id)) return live.filter((x) => x !== id);
      return live.length >= MAX_CHIPS ? live : [...live, id];
    });
  };
  const onEveryone = () => { clearSelection(); goTo(ROOT_ID); };
  const onFind = (value) => {
    setFindText(value);
    setOpenId(null);
    if (value.trim().length >= 2) { setChipIds([]); setPick(null); setAnswer(null); }
  };

  /** People ids in the order everyone is listed (most senior first), kept to `wanted`. */
  const inSeniorOrder = useCallback((wanted) => new Set(profile.everyone.keys.filter((id) => wanted.has(id))), [profile]);

  // A click on the globe is a selection like any other. A company selects
  // the whole company, all its people across groups, not the slice clicked.
  const onNodeClick = (node) => {
    if (!node || node.type === 'root') return;
    setChipIds([]);
    setFindText('');
    setAnswer(null);
    if (node.type === 'person') {
      setPick({ kind: 'person', label: node.label, keys: new Set([node.id]), sort: 'senior', nodeId: node.id });
      setOpenId(node.id);
      return;
    }
    setOpenId(null);
    const wanted = new Set();
    let company = '';
    if (node.type === 'company' && node.key !== NO_COMPANY_KEY) {
      for (const nid of atlas.companyIndex.get(node.key) || [node.id]) {
        for (const c of atlas.byId.get(nid)?.contacts || []) wanted.add(personNodeId(c));
      }
      company = node.label;
    } else {
      for (const c of node.contacts || []) wanted.add(personNodeId(c));
    }
    const label = node.type === 'company' && node.key !== NO_COMPANY_KEY ? `at ${node.label}` : node.label;
    setPick({ kind: node.type, label, keys: inSeniorOrder(wanted), sort: 'senior', company, nodeId: node.id });
  };

  const onOpenRow = (id) => setOpenId((v) => (v === id ? null : id));

  // Where the viewer is: the bubble that fills the canvas. The map reports it
  // as you pan and zoom; the breadcrumb and the panel's group rows follow.
  const viewed = atlas.byId.get(viewId);
  const viewNode = !viewed ? atlas.root : viewed.type === 'person' ? viewed.parent : viewed;
  const trail = useMemo(() => pathTo(viewNode), [viewNode]);
  const groupRows = useMemo(() => (viewNode.children || [])
    .filter((n) => n.type !== 'person')
    .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)))
    .slice(0, MAX_GROUP_ROWS), [viewNode]);

  // The panel's list: the selection's people in its own order, or the
  // people in the part of the globe in view, most senior first.
  const panelPeople = useMemo(() => {
    if (selection) return [...selection.keys].map((id) => byPersonId.get(id)).filter(Boolean);
    return sortPeople(viewNode.contacts || [], 'senior');
  }, [selection, viewNode, byPersonId]);
  const panelTitle = selection ? selection.label : viewNode.id === ROOT_ID ? 'Everyone' : viewNode.label;

  const arrange = (key) => {
    setGroupChoice(key);
    setPick((p) => (p ? { ...p, nodeId: null } : p));
    goTo(ROOT_ID);
  };

  // After an upload, the read-out is the first thing in view.
  useEffect(() => {
    if (!scrollToGlance || !hasContacts) return;
    glanceRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [scrollToGlance, hasContacts]);

  // ------------------------------------------------------------ ask

  const ask = async (text) => {
    const q = String(text ?? question).trim();
    if (!q) return;
    if (!contacts.length) {
      setAskError('Import your contacts first: there is nothing to search yet.');
      return;
    }
    setAsking(true);
    setAskError('');
    try {
      const body = { question: q };
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
      // An answer is a selection: it replaces any shortcut, Find or click.
      setChipIds([]);
      setFindText('');
      setPick(null);
      setOpenId(null);
      setAnswer(data);
      mapRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
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
  const introPaths = (company) => askExample(`Intro paths to ${company}`);

  // A link from a report ("Ask your network about Acme") arrives as ?ask=: run it once, when the contacts are in.
  const askedFromLink = useRef(false);
  useEffect(() => {
    if (askedFromLink.current || !router.isReady || mode === 'loading' || !contacts.length) return;
    const q = String(router.query?.ask || '').trim().slice(0, 300);
    if (!q) return;
    askedFromLink.current = true;
    setQuestion(q);
    ask(q);
    // `ask` is a new function each render; the ref keeps this to one run
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.query, mode, contacts.length]);

  const lastImport = (source) => (mode === 'saved' ? stats?.lastImportBySource?.[source] : memoryImports[source]);

  // ------------------------------------------------------------ render

  const connectX = () => {
    if (xStatus.configured) { window.location.assign('/api/auth/twitter'); return; }
    setUnavailable((u) => ({ ...u, x: true }));
  };

  const loading = mode === 'loading';
  const showSignIn = mode === 'memory' && !signedIn && sessionStatus !== 'loading';

  const connectors = (
    <Connectors
      counts={counts}
      lastImport={lastImport}
      busy={busy}
      loading={loading}
      firmCount={firmCount}
      onLinkedIn={() => linkedinInput.current?.click()}
      onFile={() => genericInput.current?.click()}
      xStatus={xStatus}
      xUnavailable={unavailable.x && !xStatus.configured}
      onConnectX={connectX}
      onImportX={importX}
      onDisconnectX={() => disconnect('twitter')}
      attioEnabled={ATTIO_ENABLED}
      onImportAttio={importAttio}
    />
  );

  return (
    <ChecksContext.Provider value={checksContext}>
    <PageShell flows
      title="Network Map"
      wide
    >
      <input ref={linkedinInput} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => handleFile(e, 'linkedin')} data-testid="linkedin-file" />
      <input ref={genericInput} type="file" accept=".csv,.tsv,.xlsx,.xls,.json,text/csv,application/json" className="hidden" onChange={(e) => handleFile(e, 'auto')} data-testid="generic-file" />

      <div className="space-y-4">
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
        {loadError && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{loadError}</div>
        )}

        {/* ---------------------------------------------------- empty state: the upload is the page */}
        {!hasContacts && (
          <section className={classNames('card overflow-hidden', dragging && 'ring-2 ring-brand-300')} {...dropProps}>
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <span className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-ink text-white shadow-float">
                {loading ? <HiOutlineShare style={{ width: 26, height: 26 }} /> : <HiOutlineCloudArrowUp style={{ width: 28, height: 28 }} />}
              </span>
              <p className="eyebrow">{loading ? 'Loading your network…' : 'No contacts yet'}</p>
              {!loading && (
                <>
                  <h2 className="mt-1 text-xl font-semibold tracking-tight text-ink">Drop your contacts here to draw your map</h2>
                  <p className="muted mt-1 max-w-md">See in plain words who you know, at which companies and where, with one-click lists you can copy or download. Everything stays private to you.</p>
                </>
              )}
            </div>
            <div className="space-y-2 border-t border-line px-5 py-4">
              {connectors}
              {showSignIn && (
                <p className="text-xs text-amber-700"><Link href="/signin" className="font-medium underline">Sign in to save your network</Link>; until then imports stay in this tab.</p>
              )}
            </div>
          </section>
        )}

        {hasContacts && (
          <SourceStrip
            total={contacts.length}
            counts={counts}
            labels={SOURCE_LABELS}
            colors={SOURCE_COLORS || {}}
            saved={mode === 'saved'}
            showSignIn={showSignIn}
            busy={busy}
            onRemoveAll={removeAll}
            connectors={connectors}
            sourceFilter={sourceFilter}
            onToggleSource={(s) => { clearSelection(); setSourceFilter((f) => ({ ...f, [s]: !f[s] })); goTo(ROOT_ID); }}
            firmCount={firmCount}
            directOnly={directOnly}
            onToggleDirect={() => { clearSelection(); setDirectOnly((v) => !v); goTo(ROOT_ID); }}
            dropProps={dropProps}
            dragging={dragging}
          />
        )}

        {/* ---------------------------------------------------- at a glance */}
        {hasContacts && (
          <AtAGlance
            ref={glanceRef}
            profile={profile}
            activeIds={selection?.kind === 'chips' ? liveChipIds : []}
            countFor={(id) => countIfAdded(profile, liveChipIds, id)}
            onToggle={toggleChip}
            onEveryone={onEveryone}
            everyoneActive={!selection}
            question={question}
            onQuestion={setQuestion}
            onAsk={() => ask()}
            asking={asking}
            askError={askError}
            onExample={askExample}
          />
        )}

        {/* ---------------------------------------------------- map and people */}
        {hasContacts && (
          <section ref={mapRef} className="card overflow-hidden bg-white" aria-labelledby="graph-heading">
            <h2 id="graph-heading" className="sr-only">Map</h2>
            <div className="flex flex-col lg:flex-row">
              <div className="min-w-0 flex-1 lg:border-r lg:border-line">
                <div ref={graphBoxRef} className="relative overflow-hidden bg-white">
                  {atlas.peopleCount === 0 ? (
                    <div className="flex items-center justify-center text-sm text-muted" style={{ height: graphHeight }}>No contacts match these filters.</div>
                  ) : (
                    <NetworkGraph
                      atlas={atlas}
                      width={graphWidth}
                      height={graphHeight}
                      highlightIds={highlightIds}
                      selectedId={openId || selection?.nodeId || null}
                      focus={focus}
                      theme={theme}
                      viewId={viewNode.id}
                      onNodeClick={onNodeClick}
                      onViewNode={setViewId}
                      onBackgroundClick={() => setOpenId(null)}
                      intro={!uploaded.current}
                    >
                      <button
                        type="button"
                        onClick={toggleFullscreen}
                        className="glass flex h-8 w-8 items-center justify-center rounded-lg text-ink shadow-card hover:bg-white"
                        aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
                        title={fullscreen ? 'Exit full screen' : 'Full screen'}
                      >
                        {fullscreen ? <HiOutlineArrowsPointingIn style={ICON} /> : <HiOutlineArrowsPointingOut style={{ ...ICON, transform: 'rotate(45deg)' }} />}
                      </button>
                    </NetworkGraph>
                  )}
                </div>
                {/* Under the globe: the arrangements that split this file, and where you are. */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-4 py-2 text-xs">
                  {groupings.length > 1 && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted">Arrange by</span>
                      <div className="flex rounded-lg border border-line bg-white p-0.5" role="radiogroup" aria-label="Arrange by">
                        {groupings.map(({ key }) => (
                          <button
                            key={key}
                            type="button"
                            role="radio"
                            aria-checked={groupBy === key}
                            onClick={() => arrange(key)}
                            className={classNames('rounded-md px-2 py-0.5 font-medium', groupBy === key ? 'bg-brand-50 text-brand-700' : 'text-muted hover:text-ink')}
                          >
                            {(GROUPING_LABEL[key] || key).replace(/^By (\w)/, (m, c) => c.toUpperCase())}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <nav className="flex min-w-0 flex-wrap items-center gap-1" aria-label="Where you are on the map">
                    {trail.map((node, i) => (
                      <React.Fragment key={node.id}>
                        {i > 0 && <span className="text-muted">›</span>}
                        <button
                          type="button"
                          onClick={() => goTo(node.id)}
                          className={classNames('rounded-md px-1 py-0.5', i === trail.length - 1 ? 'font-medium text-ink' : 'text-muted hover:text-ink')}
                        >
                          {node.id === ROOT_ID ? 'All' : node.label}
                          {i === trail.length - 1 && <span className="ml-1 font-normal text-muted">{fmt(node.count)}</span>}
                        </button>
                      </React.Fragment>
                    ))}
                  </nav>
                  <span className="ml-auto hidden text-muted sm:inline">Drag to spin · scroll to zoom · click to select</span>
                </div>
              </div>
              {/* On a phone the panel comes first, the globe under it. */}
              <div className="relative order-first border-b border-line lg:order-none lg:w-2/5 lg:shrink-0 lg:border-b-0">
                <div className="flex h-full max-h-96 flex-col lg:absolute lg:inset-0 lg:max-h-none">
                  <PeoplePanel
                    title={panelTitle}
                    count={panelPeople.length}
                    active={Boolean(selection)}
                    onClear={clearSelection}
                    people={panelPeople}
                    listOrder={selection ? selection.sort : 'senior'}
                    find={findText}
                    onFind={onFind}
                    groups={groupRows}
                    onGroup={goTo}
                    openId={openId}
                    onOpen={onOpenRow}
                    onIntro={introPaths}
                    company={selection?.company || ''}
                    answer={shownAnswer}
                    asking={asking}
                    resolve={resolve}
                    idOf={personNodeId}
                    heightClass="h-full"
                  />
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ---------------------------------------------------- founder checks run */}
        {signedIn && checks.length > 0 && (
          <details className="card card-pad group">
            <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
              <h2 className="section-title">Founder checks you have run</h2>
              <span className="chip">{checks.length}</span>
              <span className="ml-auto text-xs text-muted group-open:hidden">Show</span>
              <span className="ml-auto hidden text-xs text-muted group-open:inline">Hide</span>
            </summary>
            <p className="muted mt-3 text-xs">Finished deep checks from the last three days. Contacts with one are marked “Checked”.</p>
            <ul className="mt-2 divide-y divide-line">
              {checks.map((c) => (
                <li key={`${c.name}|${c.company}`} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <Link href={checkHref(c)} className="font-medium text-ink hover:text-brand-600 hover:underline">{c.name}</Link>
                  {c.company && <span className="chip">{c.company}</span>}
                  {/* Same rule as the Checked chip: matters held "if right person" are never shown as 0 red flags alone */}
                  {typeof c.redFlags === 'number' && <span className={c.redFlags ? 'chip chip-bad' : Number(c.ifRightPerson) > 0 ? 'chip chip-warn' : 'chip'}>{c.redFlags} red flag{c.redFlags === 1 ? '' : 's'}{Number(c.ifRightPerson) > 0 ? ` · ${c.ifRightPerson} serious if right person` : ''}</span>}
                  {c.date && <span className="ml-auto text-xs text-muted">{formatDate(c.date)}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </PageShell>
    </ChecksContext.Provider>
  );
}
