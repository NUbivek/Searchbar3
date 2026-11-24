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
 * One selection drives the page (spec section 2): a shortcut (narrowed by
 * up to two more in the people list), the Find box, an answer, or a click on
 * the globe. It lights people on the globe and fills the people panel; it
 * never rebuilds the globe's layout (only "Arrange by", the source chips and
 * "direct only" do). A background click on the globe, or Escape on the map
 * or the list, clears it.
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
import PeoplePanel, { sortPeople, understoodOf, RadioGroup } from '../components/network/PeoplePanel';
import SourceStrip from '../components/network/SourceStrip';
import Connectors, { X_UNAVAILABLE, plainServiceText } from '../components/network/Connectors';
import { ChecksContext, contactNameCounts, checkHref, formatDate } from '../components/network/checks';
import {
  parseContactsFile, parseXFollowing, dedupeContacts, countBySource, dedupeKey, MAX_CONTACTS,
} from '../utils/network/parseContacts';
import { buildAtlas, pathTo, personNodeId, NO_COMPANY_KEY, ROOT_ID } from '../utils/network/atlas';
import { GROUPINGS } from '../utils/network/grouping';
import { profileNetwork, combine, narrowings, shortcutFor } from '../utils/network/insights';
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
/** Parts a list can be narrowed to at once: a shortcut and two more. */
const MAX_PARTS = 3;
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
const ALL_SOURCES = { linkedin: true, csv: true, x: true, attio: true };

/** 'auto' for people who asked their system for less motion, 'smooth' otherwise. */
function scrollBehavior() {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth';
  } catch {
    return 'smooth';
  }
}

/** Lower case with accents taken off, so "jose" finds José. */
const fold = (v) => String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** The browser's own date as YYYY-MM-DD, so "this year" in a question is the user's year. */
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

  const [sourceFilter, setSourceFilter] = useState(ALL_SOURCES);
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
  const [chipIds, setChipIds] = useState([]); // the shortcut pressed, then any it was narrowed by
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
    // A source hidden before this upload would otherwise stay hidden, maybe
    // with no chip left to turn it back on.
    setSourceFilter(ALL_SOURCES);
    setDirectOnly(false);
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
      if (!response.ok) throw new Error(plainServiceText('x', data.error || `X request failed (${response.status})`));
      if (!data.followingAvailable) {
        const why = plainServiceText('x', data.note || data.error || 'X did not return your following list.');
        setXStatus((s) => ({ ...s, note: why }));
        setNotice({ kind: 'info', text: why });
        return;
      }
      const parsed = parseXFollowing({ data: data.following || [] });
      if (!parsed.contacts.length) {
        setNotice({ kind: 'info', text: 'X returned an empty following list.' });
        return;
      }
      const message = await saveSource('x', parsed.contacts, { fileTruncated: parsed.truncated || 0 });
      const dupes = parsed.duplicates ? ` ${fmt(parsed.duplicates)} duplicate accounts were merged.` : '';
      setNotice({ kind: 'success', text: `${message}${dupes}${data.note ? ` ${plainServiceText('x', data.note)}` : ''}` });
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
      // The Attio route speaks of tokens and scopes; the page says "access code", as the form does.
      if (!response.ok) throw new Error(plainServiceText('attio', data.error || `Attio import failed (${response.status})`));
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
        data.note ? plainServiceText('attio', data.note) : '',
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
      setSourceFilter(ALL_SOURCES);
      setDirectOnly(false);
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
  // With one source there is no chip to turn it back on, so its filter is ignored.
  const severalSources = Object.keys(counts).filter((s) => counts[s]).length > 1;
  const visibleContacts = useMemo(
    () => contacts.filter((c) => (!severalSources || sourceFilter[c.source] !== false) && !(directOnly && c.relationship === 'firm')),
    [contacts, sourceFilter, directOnly, severalSources],
  );
  const sourcesHidden = severalSources && Object.keys(counts).some((s) => counts[s] && sourceFilter[s] === false);
  // What hid the people an answer leaves out, named so the user knows which control to change.
  const hiddenBy = sourcesHidden && directOnly ? 'the filters above'
    : directOnly ? '“My direct connections only”' : 'the source filters above';

  // What the file holds: the read-out, the shortcuts, the example questions
  // and the arrangements that split it. Depends only on the people in view.
  const profile = useMemo(() => profileNetwork(visibleContacts), [visibleContacts]);
  const groupings = profile.groupings || [];
  // null when nothing splits the file (a list of names only): the globe then
  // shows the people by company, with no group layer named after a facet the
  // file does not have.
  const groupBy = groupChoice && groupings.some((g) => g.key === groupChoice) ? groupChoice : profile.defaultGrouping ?? null;

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

  // Shortcut ids that still exist after the people in view changed.
  const liveChipIds = useMemo(() => {
    const known = new Set([...profile.shortcuts, ...profile.more].map((s) => s.id));
    return chipIds.filter((id) => known.has(id));
  }, [chipIds, profile]);

  // An answer's people: everyone it found (its uncapped `keys`, in rank
  // order, page-2), then for intro paths the people at the company's
  // investors, each person once and only people in view. Every count, the
  // lit dots, the list, Copy and Download come from this one list.
  const answerView = useMemo(() => {
    if (!answer) return null;
    const ids = [];
    const seen = new Set();
    let hidden = 0;
    const add = (id, counts) => {
      if (seen.has(id)) return;
      seen.add(id);
      if (byPersonId.has(id)) ids.push(id);
      else if (counts) hidden += 1;
    };
    const intro = answer.intent === 'intro-path' && answer.intro ? answer.intro : null;
    const keys = intro && Array.isArray(intro.keys) ? intro.keys : answer.keys;
    if (Array.isArray(keys)) keys.forEach((k) => add(`p:${k}`, true));
    else {
      // An older reply without keys: its capped rows are all there is.
      (answer.results || []).forEach((r) => add(resolve(r.contact).id, true));
      (intro?.direct || []).forEach((r) => add(resolve(r.contact).id, true));
    }
    (intro?.viaInvestors || []).forEach((g) => {
      if (Array.isArray(g.keys)) g.keys.forEach((k) => add(`p:${k}`, false));
      else (g.contacts || []).forEach((r) => add(resolve(r.contact).id, false));
    });
    // The server answers over the people in view (the source filters and
    // "direct only" go with the question), so nobody should be left out
    // here; if a reply still holds people hidden on this page, say so.
    return { ids, answer: hidden ? { ...answer, hiddenByFilters: hidden, hiddenBy } : answer };
  }, [answer, byPersonId, resolve, hiddenBy]);
  const shownAnswer = answerView ? answerView.answer : null;

  // The one selection { kind, label, keys: Set, sort, company?, nodeId? }, or
  // null. Its key Set is built once per selection, so the globe turns and
  // pulses only when the selection really changes.
  const term = fold(findText.trim());
  const selection = useMemo(() => {
    if (answer) {
      // The title says what the list is: what the question was read as, or
      // the question itself when nothing was read from it.
      const read = understoodOf(answer);
      const q = String(answer.question || '').trim();
      const label = answer.intent === 'intro-path' && answer.intro?.target ? `Intro paths to ${answer.intro.target}`
        : read.length ? read.join(' · ') : q ? `“${q}”` : 'Your question';
      return { kind: 'answer', label, keys: new Set(answerView.ids), sort: null };
    }
    if (pick) {
      // Only people still in view (globe-m3): a source turned off since the
      // click takes its people out of the selection too.
      const keys = [...pick.keys].filter((id) => byPersonId.has(id));
      return keys.length === pick.keys.size ? pick : { ...pick, keys: new Set(keys) };
    }
    if (term.length >= 2) {
      // Most senior first, as everyone is listed. Accents are folded on both sides.
      const keys = new Set(profile.everyone.keys.filter((id) => {
        const c = byPersonId.get(id);
        return c && [c.name, c.company, c.position].some((v) => fold(v).includes(term));
      }));
      return { kind: 'find', label: `Find “${findText.trim()}”`, keys, sort: 'senior' };
    }
    if (liveChipIds.length) {
      // One company shortcut is a company selection: the panel offers its
      // profile and intro paths. Not for a company read from email addresses
      // ("at stripe.com"): that is a web address, not a company name.
      const chip = liveChipIds.length === 1 && liveChipIds[0].startsWith('company:')
        ? [...profile.shortcuts, ...profile.more].find((s) => s.id === liveChipIds[0]) : null;
      const only = chip && !chip.fromEmail ? chip : null;
      return { kind: 'chips', ...combine(profile, liveChipIds), company: only ? only.short.replace(/^at /, '') : '' };
    }
    return null;
  }, [answer, answerView, pick, term, findText, liveChipIds, profile, byPersonId]);
  const highlightIds = selection ? selection.keys : NO_IDS;

  // The shortcut in use: the one pressed, or the one holding exactly the
  // people selected some other way (a tag group clicked on the globe holds
  // the same people as its chip, B13).
  const pressedId = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === 'chips') return liveChipIds[0];
    return shortcutFor(profile, selection.keys);
  }, [selection, liveChipIds, profile]);

  // "Narrow to" in the people list (R1): the list's parts so far (a shortcut,
  // or a click that equals one), and the other shortcuts that would narrow it.
  const baseIds = selection?.kind === 'chips' ? liveChipIds : selection && selection.kind !== 'answer' && pressedId ? [pressedId] : [];
  const narrow = useMemo(
    () => (baseIds.length && baseIds.length < MAX_PARTS && selection.keys.size > 1 ? narrowings(profile, baseIds) : []),
    // baseIds is rebuilt each render; its parts are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile, baseIds.join('|'), selection],
  );
  const shortcutById = useMemo(() => new Map([...profile.shortcuts, ...profile.more].map((s) => [s.id, s])), [profile]);
  const parts = liveChipIds.length >= 2 ? liveChipIds.map((id) => ({ id, label: shortcutById.get(id)?.short || id })) : [];

  /** Press a shortcut: it becomes the selection; pressing the one in use goes back to everyone. */
  const toggleChip = (id) => {
    setFindText('');
    setPick(null);
    setAnswer(null);
    setOpenId(null);
    setChipIds(id === pressedId ? [] : [id]);
  };
  /** Narrow the list by one more shortcut (AND), up to three parts in all. */
  const onNarrow = (id) => {
    const next = [...baseIds.filter((x) => x !== id), id].slice(0, MAX_PARTS);
    setFindText('');
    setPick(null);
    setAnswer(null);
    setOpenId(null);
    setChipIds(next);
  };
  /** Take one part out of a narrowed list: it widens again. */
  const onRemovePart = (id) => { setOpenId(null); setChipIds((prev) => prev.filter((x) => x !== id)); };
  const onEveryone = () => { clearSelection(); goTo(ROOT_ID); };
  const onFind = (value) => {
    setFindText(value);
    setOpenId(null);
    if (value.trim().length >= 2) { setChipIds([]); setPick(null); setAnswer(null); }
  };

  /** People ids in the order everyone is listed (most senior first), kept to `wanted`. */
  const inSeniorOrder = useCallback((wanted) => new Set(profile.everyone.keys.filter((id) => wanted.has(id))), [profile]);

  // A click on the globe is a selection like any other. The globe flies
  // into what was clicked by itself and reports it through onViewNode, so
  // the breadcrumb follows (R5, R6). A company selects the whole company,
  // all its people across groups, not the slice clicked; a tag group selects
  // everyone who carries the tag, wherever they sit on the map (R3).
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
    const isCompany = node.type === 'company' && node.key !== NO_COMPANY_KEY;
    if (isCompany) {
      for (const nid of atlas.companyIndex.get(node.key) || [node.id]) {
        for (const c of atlas.byId.get(nid)?.contacts || []) wanted.add(personNodeId(c));
      }
    } else if (atlas.groupIndex?.has(node.id)) {
      for (const id of atlas.groupIndex.get(node.id)) wanted.add(id);
    } else {
      for (const c of node.contacts || []) wanted.add(personNodeId(c));
    }
    const keys = inSeniorOrder(wanted);
    // The same people as a shortcut: say it in the shortcut's words, so the
    // title matches the chip shown pressed ("tagged “cold”", "investors").
    const same = shortcutById.get(shortcutFor(profile, keys));
    const label = same ? same.short : isCompany ? `at ${node.label}` : node.label;
    setPick({ kind: node.type, label, keys, sort: 'senior', company: isCompany ? node.label : '', nodeId: node.id });
  };

  // The panel says which person to open (a bare person id) or null to close;
  // it tracks which of several rows of the same person is open.
  const onOpenRow = (id) => setOpenId(id || null);

  // Where the viewer is: the bubble that fills the canvas. The map reports it
  // as you pan and zoom; the breadcrumb and the panel's group rows follow.
  const viewed = atlas.byId.get(viewId);
  const viewNode = !viewed ? atlas.root : viewed.type === 'person' ? viewed.parent : viewed;
  const trail = useMemo(() => pathTo(viewNode), [viewNode]);
  // In the atlas's own order: named groups largest first, then "Other …"
  // and "not known" (R4), with the atlas's colours for their dots.
  const groupRows = useMemo(() => (viewNode.children || [])
    .filter((n) => n.type !== 'person')
    .slice(0, MAX_GROUP_ROWS), [viewNode]);

  // The panel's list: the selection's people in its own order, or the
  // people in the part of the globe in view, most senior first.
  // Two lists, so a globe move under a selection (the camera turning to the
  // lit people, a spin, a zoom) never makes a new list and so never resets
  // the sort or the pages the user opened.
  const selectedPeople = useMemo(
    () => (selection ? [...selection.keys].map((id) => byPersonId.get(id)).filter(Boolean) : null),
    [selection, byPersonId],
  );
  const viewPeople = useMemo(
    () => (selection ? null : sortPeople(viewNode.contacts || [], 'senior')),
    [selection, viewNode],
  );
  const panelPeople = selectedPeople || viewPeople;
  const panelTitle = selection ? selection.label : viewNode.id === ROOT_ID ? 'Everyone' : viewNode.label;

  const arrange = (key) => {
    setGroupChoice(key);
    setPick((p) => (p ? { ...p, nodeId: null } : p));
    goTo(ROOT_ID);
  };

  // After an upload, the read-out is the first thing in view.
  useEffect(() => {
    if (!scrollToGlance || !hasContacts) return;
    glanceRef.current?.scrollIntoView?.({ behavior: scrollBehavior(), block: 'start' });
  }, [scrollToGlance, hasContacts]);

  // ------------------------------------------------------------ ask

  /**
   * Ask the network. `fromPage` marks a question the page built itself (an
   * example, a link from a report) and `target` a company given as data
   * (Intro paths): the server never sends either to a model (R8 #10). The
   * question is answered over the people in view: signed in, the source
   * filters and "direct only" go with it; otherwise only those people are
   * sent (R8 #9, page-m1).
   */
  const ask = async (text, { fromPage = false, target = '' } = {}) => {
    const q = target ? '' : String(text ?? question).trim();
    if (!q && !target) return;
    if (!contacts.length) {
      setAskError('Import your contacts first: there is nothing to search yet.');
      return;
    }
    if (!visibleContacts.length) {
      setAskError('All sources are hidden. Turn one back on to ask about your network.');
      return;
    }
    setAsking(true);
    setAskError('');
    try {
      const body = target ? { target } : { question: q };
      if (fromPage) body.fromPage = true;
      body.today = localToday();
      body.filters = {
        directOnly,
        ...(sourcesHidden ? { sources: Object.keys(counts).filter((s2) => counts[s2] && sourceFilter[s2] !== false) } : {}),
      };
      if (mode !== 'saved') {
        // Signed out, the server has no copy: send only the people in view
        // and only what scoring uses (never email), plus the identity key so
        // results map back to the globe.
        body.contacts = visibleContacts.map((c) => ({
          key: dedupeKey(c), name: c.name, company: c.company, position: c.position, location: c.location,
          profileUrl: c.profileUrl, connectedOn: c.connectedOn, source: c.source, tags: c.tags,
          ...(c.relationship === 'firm' ? { relationship: 'firm', via: c.via || '' } : {}),
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
      mapRef.current?.scrollIntoView?.({ behavior: scrollBehavior(), block: 'nearest' });
    } catch (error) {
      setAskError(error.message);
    } finally {
      setAsking(false);
    }
  };

  // The examples are built by the page from the file: never read by a model.
  const askExample = (text) => {
    setQuestion(text);
    ask(text, { fromPage: true });
  };
  // The company goes as data, never inside a question (ask-3).
  const introPaths = (company) => ask(null, { target: company });

  // A link from a report ("Ask your network about Acme") arrives as ?ask=: run it once, when the contacts are in.
  const askedFromLink = useRef(false);
  useEffect(() => {
    if (askedFromLink.current || !router.isReady || mode === 'loading' || !contacts.length) return;
    const q = String(router.query?.ask || '').trim().slice(0, 300);
    if (!q) return;
    askedFromLink.current = true;
    setQuestion(q);
    // Built by another page of the app (a report's "Ask your network"), not typed here.
    ask(q, { fromPage: true });
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
                  <p className="muted mt-1 max-w-md">See in plain words who you know, at which companies and where, with one-click lists you can copy or download. Your contacts are never shared and never sent to a model.</p>
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
            pressedId={pressedId}
            onToggle={toggleChip}
            onEveryone={onEveryone}
            everyoneActive={!selection}
            question={question}
            onQuestion={setQuestion}
            onAsk={() => ask()}
            asking={asking}
            askError={askError}
            onExample={askExample}
            allHidden={visibleContacts.length === 0}
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
                      onBackgroundClick={clearSelection}
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
                      <RadioGroup
                        label="Arrange by"
                        className="flex rounded-lg border border-line bg-white p-0.5"
                        options={groupings.map(({ key }) => ({ key, label: (GROUPING_LABEL[key] || key).replace(/^By (\w)/, (m, c) => c.toUpperCase()) }))}
                        isChecked={(key) => groupBy === key}
                        onChange={arrange}
                        buttonClass={(on) => classNames('min-h-9 rounded-md px-2 py-0.5 font-medium sm:min-h-0', on ? 'bg-brand-50 text-brand-700' : 'text-muted hover:text-ink')}
                      />
                    </div>
                  )}
                  <nav className="flex min-w-0 flex-wrap items-center gap-1" aria-label="Where you are on the map">
                    {trail.map((node, i) => (
                      <React.Fragment key={node.id}>
                        {i > 0 && <span className="text-muted">›</span>}
                        <button
                          type="button"
                          onClick={() => goTo(node.id)}
                          aria-current={i === trail.length - 1 ? 'location' : undefined}
                          className={classNames('rounded-md px-1 py-0.5', i === trail.length - 1 ? 'font-medium text-ink' : 'text-muted hover:text-ink')}
                        >
                          {node.id === ROOT_ID ? 'All' : node.label}
                          {/* A real space, so the name and count are read as two words. */}
                          {i === trail.length - 1 && <>{' '}<span className="font-normal text-muted">{fmt(node.count)}</span></>}
                        </button>
                      </React.Fragment>
                    ))}
                  </nav>
                  <span className="ml-auto hidden text-muted sm:inline">Drag to spin · scroll to zoom · click to select</span>
                </div>
              </div>
              {/* On a phone the panel comes first, the globe under it. */}
              <div className="relative order-first border-b border-line lg:order-none lg:w-2/5 lg:shrink-0 lg:border-b-0">
                {/* network-panel (globals.css): most of a phone's screen, so the list shows several people before the globe. */}
                <div className="network-panel flex flex-col lg:absolute lg:inset-0">
                  <PeoplePanel
                    title={panelTitle}
                    count={panelPeople.length}
                    narrow={narrow}
                    onNarrow={onNarrow}
                    parts={parts}
                    onRemovePart={onRemovePart}
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
                    downloadName={shownAnswer ? shownAnswer.question || panelTitle : panelTitle}
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
