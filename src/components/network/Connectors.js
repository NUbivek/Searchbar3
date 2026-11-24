/**
 * Where contacts come from: LinkedIn's export, any CSV or XLSX, X follows
 * and the firm's Attio CRM, one small card each. With no contacts yet these
 * cards are the page; afterwards they open from "Add or replace".
 */
import React, { useState } from 'react';
import { HiOutlineArrowUpTray, HiOutlineInformationCircle } from 'react-icons/hi2';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const formatTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
export const X_UNAVAILABLE = "X connection isn't available on this deployment yet";

// Words the interface never shows. The X and Attio routes speak in their own
// developer terms ("token", "API", "scope"); the page says the same in plain
// words, and calls Attio's credential an access code as the form does.
const BANNED_WORDS = /\b(api|keys?|tokens?|free|paid|tiers?|quota|scopes?)\b/i;
const PLAIN = {
  attio: [
    [/paste/i, 'Paste an Attio access code.'],
    [/rejected|401|unauthori[sz]ed/i, 'Attio did not accept this access code. Check that it was copied in full and try again.'],
    [/workspace members/i, 'This Attio access code cannot see who in the workspace knows whom, so every contact was saved as firm-wide. Create one that can read workspace members to mark your own connections as direct.'],
    [/people records|permission|403/i, 'This access code cannot read People and Companies in Attio. Create one that can read them and try again.'],
    [/rate|429/i, 'Attio is busy right now. Try again in a few minutes.'],
  ],
  x: [
    [/follow|json/i, 'X does not share who you follow with this app yet. You can still upload your X following list as a JSON file, or add the people to a CSV.'],
    [/rate/i, 'X is limiting requests right now. Try again in 15 minutes.'],
    [/expired|authenticat/i, 'Your X session expired. Connect X again.'],
  ],
};
const FALLBACK = {
  attio: 'The Attio import did not work. Check the access code and try again.',
  x: 'X did not return your following list. Try again later.',
};
/**
 * An X or Attio message as the user should read it: text that already avoids
 * the banned words is kept; anything else is put in plain words.
 */
export function plainServiceText(service, text) {
  const t = String(text || '').trim();
  if (t && !BANNED_WORDS.test(t)) return t;
  const hit = (PLAIN[service] || []).find(([re]) => re.test(t));
  return hit ? hit[1] : (FALLBACK[service] || 'That did not work. Please try again.');
}
const LINKEDIN_HOW = 'LinkedIn: Settings & Privacy → Data privacy → Get a copy of your data → Connections. LinkedIn emails a zip within minutes; upload the Connections.csv inside it. LinkedIn never shares connections with apps, so the export is the only way in.';

/** One tight card: a source, what is in from it, and its action. */
function Card({ title, note, children }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-white p-3">
      <div>
        <div className="text-sm font-medium text-ink">{title}</div>
        <div className="mt-0.5 text-xs leading-snug text-muted">{note}</div>
      </div>
      <div className="mt-auto">{children}</div>
    </div>
  );
}

export default function Connectors({
  counts, lastImport, busy, loading, firmCount, onLinkedIn, onFile,
  xStatus, xUnavailable, onConnectX, onImportX, onDisconnectX, attioEnabled, onImportAttio,
}) {
  const [attioOpen, setAttioOpen] = useState(false);
  const [code, setCode] = useState('');
  const since = (source) => (lastImport(source) ? ` · ${formatTime(lastImport(source))}` : '');
  const submitAttio = async (event) => {
    event.preventDefault();
    const value = code.trim();
    if (!value) return;
    // The code is used for this one import and then dropped.
    if (await onImportAttio(value)) { setCode(''); setAttioOpen(false); }
  };
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <Card
        title={(
          <span className="inline-flex items-center gap-1.5">
            LinkedIn
            <span className="inline-flex items-center text-muted hover:text-ink" title={LINKEDIN_HOW} aria-label="How to get your LinkedIn connections" role="img">
              <HiOutlineInformationCircle style={{ width: 15, height: 15 }} />
            </span>
          </span>
        )}
        note={counts.linkedin ? `${fmt(counts.linkedin)} connections${since('linkedin')}` : 'Your connections, from the Connections.csv export.'}
      >
        <button type="button" onClick={onLinkedIn} disabled={Boolean(busy) || loading} className="btn-primary w-full py-2 text-xs">
          <HiOutlineArrowUpTray style={{ width: 13, height: 13 }} /> {busy === 'linkedin' ? 'Importing…' : counts.linkedin ? 'Replace export' : 'Upload Connections.csv'}
        </button>
      </Card>
      <Card title="CSV / XLSX" note={counts.csv ? `${fmt(counts.csv)} contacts${since('csv')}` : 'Any spreadsheet with names and companies.'}>
        <button type="button" onClick={onFile} disabled={Boolean(busy) || loading} className="btn-secondary w-full py-2 text-xs">
          <HiOutlineArrowUpTray style={{ width: 13, height: 13 }} /> {busy === 'auto' ? 'Importing…' : counts.csv ? 'Replace file' : 'Upload contacts'}
        </button>
      </Card>
      <Card title="X" note={xStatus.connected ? `Connected as @${xStatus.username || 'you'}.` : 'The accounts you follow, where X allows it.'}>
        {xStatus.connected ? (
          <div className="flex gap-1">
            <button type="button" onClick={onImportX} disabled={Boolean(busy)} className="btn-secondary flex-1 py-2 text-xs">{busy === 'x' ? 'Importing…' : 'Import follows'}</button>
            <button type="button" onClick={onDisconnectX} className="btn-ghost text-xs">Disconnect</button>
          </div>
        ) : <button type="button" onClick={onConnectX} className="btn-secondary w-full py-2 text-xs">Connect X</button>}
      </Card>
      <Card
        title={<span>Attio <span className="font-normal text-muted">· firm CRM</span></span>}
        note={counts.attio ? `${fmt(counts.attio)} people, ${fmt(firmCount)} firm-wide.` : "The firm's contacts, kept apart from yours."}
      >
        {attioEnabled
          ? <button type="button" onClick={() => setAttioOpen((v) => !v)} className="btn-secondary w-full py-2 text-xs">{counts.attio ? 'Re-import from Attio' : 'Connect Attio'}</button>
          : <button type="button" disabled className="btn-secondary w-full py-2 text-xs" title="Not connected yet">Connect Attio · soon</button>}
      </Card>
      {xUnavailable && <p className="muted text-xs sm:col-span-2 lg:col-span-4" role="status">{X_UNAVAILABLE}.</p>}
      {xStatus.note && <p className="text-xs text-amber-700 sm:col-span-2 lg:col-span-4">{plainServiceText('x', xStatus.note)}</p>}
      {attioOpen && (
        <form onSubmit={submitAttio} className="rounded-xl border border-line bg-slate-50 p-3.5 sm:col-span-2 lg:col-span-4">
          <p className="text-sm text-ink">Connect Attio</p>
          <p className="mt-0.5 text-xs text-muted">
            Paste the access code from Attio (Workspace settings → Developers). It is used once to read People, Companies and workspace members, and is not stored.
            People whose strongest connection in Attio is you are saved as <span className="font-medium text-slate-700">direct</span>; everyone else is a <span className="font-medium text-slate-700">firm-wide</span> contact, labelled with the colleague who knows them.
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              type="password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Attio access code"
              aria-label="Attio access code"
              autoComplete="off"
              className="input flex-1 py-2"
            />
            <button type="submit" disabled={Boolean(busy) || !code.trim()} className="btn-primary px-4 py-2">{busy === 'attio' ? 'Importing…' : 'Import from Attio'}</button>
            <button type="button" onClick={() => { setAttioOpen(false); setCode(''); }} className="btn-ghost justify-center">Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
