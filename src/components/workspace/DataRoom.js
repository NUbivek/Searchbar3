/**
 * Data room for a deal workspace: upload documents (PDF, DOCX, CSV, TXT, MD),
 * list/delete them, and ask questions answered from their text with [Dn]
 * citation chips that expand to show the passage.
 *
 * PDF/DOCX/CSV are parsed by the existing /api/upload (uploadFiles); plain
 * text and Markdown are read in the browser. The parsed text is then stored
 * through /api/workspaces/:id/documents.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { HiOutlineArrowUpTray, HiOutlineSparkles, HiOutlineDocumentText, HiOutlineArrowTopRightOnSquare } from 'react-icons/hi2';
import { uploadFiles } from '../../utils/fileHandlers';

const ICON = { width: 15, height: 15 };

const ACCEPT = '.pdf,.docx,.csv,.txt,.md,.markdown';
const SERVER_PARSED = /\.(pdf|docx|csv)$/i;
const BROWSER_TEXT = /\.(txt|md|markdown)$/i;
const UPLOAD_BATCH = 5; // /api/upload accepts at most 5 files per request
const MAX_DOCS_PER_POST = 10;

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function formatSize(chars) {
  const n = Number(chars) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M chars`;
  if (n >= 1000) return `${Math.round(n / 1000)}k chars`;
  return `${n} chars`;
}

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Render numbers (e.g. $4.2M, 71%, 26 months) in the highlight style. */
function highlightNumbers(text, keyPrefix) {
  const parts = String(text).split(/(\$?\d[\d,]*(?:\.\d+)?\s?(?:%|[kKmMbB]\b|million|billion)?)/g);
  return parts.map((part, i) => (i % 2 === 1
    ? <span key={`${keyPrefix}-n${i}`} className="rounded bg-brand-50 px-1 font-semibold text-brand-700">{part}</span>
    : <React.Fragment key={`${keyPrefix}-t${i}`}>{part}</React.Fragment>));
}

function CitationChip({ label, active, onClick, missing }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={missing}
      className={`cite mx-0.5 disabled:cursor-not-allowed disabled:opacity-50 ${active ? '!bg-brand-600 !text-white' : ''}`}
      aria-expanded={active}
      title={missing ? 'Passage unavailable' : 'Show passage'}
    >
      {label}
    </button>
  );
}

function AnswerText({ text, citationsByLabel, openLabel, onToggle }) {
  const lines = String(text || '').split('\n');
  return (
    <div className="space-y-2 text-sm leading-relaxed text-slate-700">
      {lines.map((line, li) => {
        const pieces = line.split(/(\[[DS]\d+\])/g);
        return (
          <p key={`l${li}`}>
            {pieces.map((piece, pi) => {
              const m = piece.match(/^\[([DS]\d+)\]$/);
              if (m) {
                return (
                  <CitationChip
                    key={`l${li}-c${pi}`}
                    label={m[1]}
                    active={openLabel === m[1]}
                    missing={!citationsByLabel.has(m[1])}
                    onClick={() => onToggle(m[1])}
                  />
                );
              }
              return <React.Fragment key={`l${li}-p${pi}`}>{highlightNumbers(piece, `l${li}-p${pi}`)}</React.Fragment>;
            })}
          </p>
        );
      })}
    </div>
  );
}

function PassageCard({ citation }) {
  const isSource = Boolean(citation.sourceName && !citation.docName);
  return (
    <div className="mt-3 rounded-xl border border-line bg-slate-50/70 px-3.5 py-3 text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <span className="cite">[{citation.label}]</span>
        {isSource ? (
          <>
            {citation.sourceName}
            {citation.title ? ` · ${citation.title}` : ''}
            {citation.url && (
              <a href={citation.url} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-1 font-medium text-brand-600 hover:underline">open <HiOutlineArrowTopRightOnSquare style={{ width: 11, height: 11 }} /></a>
            )}
          </>
        ) : (
          <>{citation.docName} · passage {Number(citation.passageIndex) + 1}</>
        )}
      </div>
      <p className="whitespace-pre-wrap text-slate-700">{highlightNumbers(citation.text, `pc-${citation.label}`)}</p>
    </div>
  );
}

export default function DataRoom({ workspaceId }) {
  const [documents, setDocuments] = useState([]);
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadMessage, setUploadMessage] = useState('');
  const [docError, setDocError] = useState('');
  const [question, setQuestion] = useState('');
  const [includeSources, setIncludeSources] = useState(false);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState('');
  const [result, setResult] = useState(null);
  const [openLabel, setOpenLabel] = useState(null);
  const [showAllPassages, setShowAllPassages] = useState(false);
  const fileInput = useRef(null);
  const base = `/api/workspaces/${workspaceId}`;

  const loadDocuments = useCallback(async () => {
    if (!workspaceId) return;
    setLoadingDocs(true);
    try {
      const data = await readJson(await fetch(`${base}/documents`));
      setDocuments(data.documents || []);
      setDocError('');
    } catch (error) {
      setDocError(error.message);
    } finally {
      setLoadingDocs(false);
    }
  }, [base, workspaceId]);

  useEffect(() => { loadDocuments(); }, [loadDocuments]);

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setUploading(true);
    setProgress(0);
    setDocError('');
    setUploadMessage('');
    const parsed = [];
    const problems = [];
    try {
      const unsupported = files.filter((f) => !SERVER_PARSED.test(f.name) && !BROWSER_TEXT.test(f.name));
      unsupported.forEach((f) => problems.push(`${f.name}: unsupported type`));

      for (const f of files.filter((x) => BROWSER_TEXT.test(x.name))) {
        parsed.push({ name: f.name, content: await f.text() });
      }

      const serverFiles = files.filter((f) => SERVER_PARSED.test(f.name));
      for (let i = 0; i < serverFiles.length; i += UPLOAD_BATCH) {
        const batch = serverFiles.slice(i, i + UPLOAD_BATCH);
        let data;
        try {
          data = await uploadFiles(batch, (pct) => setProgress(Math.round(((i + (pct / 100) * batch.length) / serverFiles.length) * 100)));
        } catch (error) {
          const detail = error.response?.data?.details || error.response?.data?.error || error.message;
          batch.forEach((f) => problems.push(`${f.name}: ${detail}`));
          continue;
        }
        if (!data?.files) {
          batch.forEach((f) => problems.push(`${f.name}: ${data?.details || data?.error || 'could not be parsed'}`));
          continue;
        }
        for (const f of data.files) {
          if (f.error || !String(f.content || '').trim()) problems.push(`${f.name}: ${f.error || 'no readable text'}`);
          else parsed.push({ name: f.name, content: String(f.content) });
        }
      }

      let stored = 0;
      for (let i = 0; i < parsed.length; i += MAX_DOCS_PER_POST) {
        const chunk = parsed.slice(i, i + MAX_DOCS_PER_POST);
        try {
          const data = await readJson(await fetch(`${base}/documents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: chunk }),
          }));
          stored += (data.documents || []).length;
          (data.errors || []).forEach((e) => problems.push(`${e.name}: ${e.error}`));
        } catch (error) {
          chunk.forEach((f) => problems.push(`${f.name}: ${error.message}`));
        }
      }
      if (stored) setUploadMessage(`Added ${stored} document${stored === 1 ? '' : 's'}.`);
      if (problems.length) setDocError(problems.join(' · '));
      await loadDocuments();
    } finally {
      setUploading(false);
      setProgress(0);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const removeDocument = async (doc) => {
    if (typeof window !== 'undefined' && !window.confirm(`Remove "${doc.name}" from the data room?`)) return;
    try {
      await readJson(await fetch(`${base}/documents?docId=${encodeURIComponent(doc.id)}`, { method: 'DELETE' }));
      setDocuments((list) => list.filter((d) => d.id !== doc.id));
    } catch (error) {
      setDocError(error.message);
    }
  };

  const ask = async (event) => {
    event?.preventDefault();
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setAskError('');
    setResult(null);
    setOpenLabel(null);
    setShowAllPassages(false);
    try {
      const data = await readJson(await fetch(`${base}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, includeSources }),
      }));
      setResult(data);
    } catch (error) {
      setAskError(error.message);
    } finally {
      setAsking(false);
    }
  };

  const citationsByLabel = new Map([...(result?.passages || []), ...(result?.citations || [])].map((c) => [c.label, c]));
  const openCitation = openLabel ? citationsByLabel.get(openLabel) : null;
  const noDocs = !loadingDocs && documents.length === 0;

  return (
    <div className="space-y-4">
      <div className="card card-pad">
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-2">
            <h2 className="section-title">Data room</h2>
            {documents.length > 0 && <span className="chip">{documents.length}</span>}
          </div>
          <label className={`btn-primary shrink-0 ${uploading ? 'cursor-wait opacity-60' : 'cursor-pointer'}`}>
            <HiOutlineArrowUpTray style={ICON} /> {uploading ? 'Uploading…' : 'Upload documents'}
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              disabled={uploading}
              onChange={(e) => handleFiles(e.target.files)}
            />
          </label>
        </div>
        <p className="muted mb-3">Upload a deck, financials or memos (PDF, DOCX, CSV, TXT, MD) and ask questions answered from them.</p>
        {uploading && progress > 0 && (
          <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-1.5 rounded-full transition-all" style={{ width: `${progress}%`, background: 'rgb(var(--c-ink))' }} />
          </div>
        )}
        {uploadMessage && <p className="mb-2 text-sm text-emerald-700" role="status">{uploadMessage}</p>}
        {docError && <p className="mb-2 text-sm text-rose-600" role="alert">{docError}</p>}
        {loadingDocs ? (
          <div className="space-y-2" aria-busy="true">
            <div className="skeleton h-4 w-1/2" />
            <div className="skeleton h-4 w-1/3" />
          </div>
        ) : noDocs ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center">
            <p className="muted">No documents yet. Upload the first one to ask questions about it.</p>
            <button type="button" className="btn-secondary mt-3" disabled={uploading} onClick={() => fileInput.current?.click()}>
              <HiOutlineArrowUpTray style={ICON} /> Upload documents
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {documents.map((doc) => (
              <li key={doc.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600"><HiOutlineDocumentText style={{ width: 16, height: 16 }} /></span>
                  <div className="min-w-0">
                    <span className="block truncate font-medium text-ink">{doc.name}</span>
                    <span className="block text-xs text-muted">{formatSize(doc.size)}{doc.created_at ? ` · ${formatDate(doc.created_at)}` : ''}</span>
                  </div>
                </div>
                <button type="button" onClick={() => removeDocument(doc)} className="btn-danger shrink-0 px-2 py-1 text-xs">Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card card-pad">
        <form onSubmit={ask} className="space-y-3">
          <label htmlFor="dataroom-question" className="section-title block">Ask the data room</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="dataroom-question"
              type="text"
              value={question}
              maxLength={2000}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. What is the monthly burn and runway?"
              className="input"
            />
            <button
              type="submit"
              disabled={asking || !question.trim() || (noDocs && !includeSources)}
              className="btn-primary shrink-0"
            >
              <HiOutlineSparkles style={ICON} /> {asking ? 'Searching…' : 'Ask'}
            </button>
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" className="h-4 w-4 rounded border-line text-brand-600 focus:ring-brand-500/30" checked={includeSources} onChange={(e) => setIncludeSources(e.target.checked)} />
            Also search curated sources
          </label>
        </form>

        {asking && (
          <div className="mt-4" aria-busy="true" aria-live="polite">
            <p className="flex items-center gap-2 text-sm text-ink">
              <HiOutlineSparkles className="text-brand-500 animate-glow" style={{ width: 16, height: 16 }} />
              Reading the documents…
            </p>
            <div className="mt-3 space-y-2">
              <div className="skeleton h-3 w-full" />
              <div className="skeleton h-3 w-5/6" />
              <div className="skeleton h-3 w-2/3" />
            </div>
          </div>
        )}
        {askError && <p className="mt-3 text-sm text-rose-600" role="alert">{askError}</p>}

        {result && (
          <div className="ai-card mt-4 p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              {result.mode === 'ai'
                ? <span className="ai-badge"><HiOutlineSparkles style={{ width: 13, height: 13 }} /> AI answer, citations verified</span>
                : <span className="chip chip-active">Quoted from the documents</span>}
              {result.note && <span className="text-muted">{result.note}</span>}
            </div>
            {result.notFound ? (
              <p className="text-sm text-slate-700">Not found in the documents.</p>
            ) : (
              <AnswerText
                text={result.answer}
                citationsByLabel={citationsByLabel}
                openLabel={openLabel}
                onToggle={(label) => setOpenLabel((cur) => (cur === label ? null : label))}
              />
            )}
            {openCitation && <PassageCard citation={openCitation} />}

            {(result.passages || []).length > 0 && (
              <div className="mt-4">
                <button type="button" onClick={() => setShowAllPassages((v) => !v)} className="btn-ghost -ml-2.5 text-xs">
                  {showAllPassages ? 'Hide' : 'Show'} the {result.passages.length} passage{result.passages.length === 1 ? '' : 's'} searched
                </button>
                {showAllPassages && result.passages.map((p) => <PassageCard key={p.label} citation={p} />)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
