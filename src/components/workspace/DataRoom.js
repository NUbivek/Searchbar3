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
import { uploadFiles } from '../../utils/fileHandlers';

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
    ? <span key={`${keyPrefix}-n${i}`} style={{ fontWeight: 700, color: '#0066cc', backgroundColor: '#0066cc15', borderRadius: 3, padding: '0 2px' }}>{part}</span>
    : <React.Fragment key={`${keyPrefix}-t${i}`}>{part}</React.Fragment>));
}

function CitationChip({ label, active, onClick, missing }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={missing}
      className={`inline-flex items-center mx-0.5 px-1.5 rounded text-xs font-semibold align-baseline border ${
        active ? 'bg-blue-500 text-white border-blue-500' : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
      }`}
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
    <div className="space-y-2 text-gray-800 text-sm leading-relaxed">
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
    <div className="mt-3 border-l-4 border-blue-300 bg-gray-50 rounded p-3 text-sm">
      <div className="text-xs text-gray-500 mb-1">
        <span className="font-semibold text-blue-700 mr-2">[{citation.label}]</span>
        {isSource ? (
          <>
            {citation.sourceName}
            {citation.title ? ` · ${citation.title}` : ''}
            {citation.url && (
              <a href={citation.url} target="_blank" rel="noopener noreferrer" className="ml-2 text-blue-600 hover:underline">open</a>
            )}
          </>
        ) : (
          <>{citation.docName} · passage {Number(citation.passageIndex) + 1}</>
        )}
      </div>
      <p className="text-gray-700 whitespace-pre-wrap">{highlightNumbers(citation.text, `pc-${citation.label}`)}</p>
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
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-800">Data room</h2>
            <p className="text-sm text-gray-500">Upload a deck, financials or memos (PDF, DOCX, CSV, TXT, MD) and ask questions answered from them.</p>
          </div>
          <label className={`shrink-0 px-4 py-2 rounded text-sm font-medium text-white ${uploading ? 'bg-blue-300 cursor-wait' : 'bg-blue-500 hover:bg-blue-600 cursor-pointer'}`}>
            {uploading ? 'Uploading...' : 'Upload documents'}
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
        {uploading && progress > 0 && (
          <div className="w-full bg-gray-100 rounded h-1.5 mb-3">
            <div className="bg-blue-500 h-1.5 rounded" style={{ width: `${progress}%` }} />
          </div>
        )}
        {uploadMessage && <p className="text-sm text-green-700 mb-2">{uploadMessage}</p>}
        {docError && <p className="text-sm text-red-600 mb-2" role="alert">{docError}</p>}
        {loadingDocs ? (
          <p className="text-sm text-gray-500">Loading documents...</p>
        ) : noDocs ? (
          <p className="text-sm text-gray-500">No documents yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {documents.map((doc) => (
              <li key={doc.id} className="flex items-center justify-between py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-medium text-gray-800 truncate">{doc.name}</span>
                  <span className="text-gray-400 ml-2">{formatSize(doc.size)}{doc.created_at ? ` · ${formatDate(doc.created_at)}` : ''}</span>
                </div>
                <button type="button" onClick={() => removeDocument(doc)} className="text-gray-400 hover:text-red-600 text-xs ml-3">Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <form onSubmit={ask} className="space-y-3">
          <label htmlFor="dataroom-question" className="block text-sm font-medium text-gray-700">Ask the data room</label>
          <div className="flex gap-2">
            <input
              id="dataroom-question"
              type="text"
              value={question}
              maxLength={2000}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. What is the monthly burn and runway?"
              className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
            <button
              type="submit"
              disabled={asking || !question.trim() || (noDocs && !includeSources)}
              className="px-4 py-2 rounded text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 disabled:bg-blue-300"
            >
              {asking ? 'Searching...' : 'Ask'}
            </button>
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-gray-600">
            <input type="checkbox" checked={includeSources} onChange={(e) => setIncludeSources(e.target.checked)} />
            Also search curated sources
          </label>
        </form>

        {asking && <p className="text-sm text-gray-500 mt-3">Reading the documents...</p>}
        {askError && <p className="text-sm text-red-600 mt-3" role="alert">{askError}</p>}

        {result && (
          <div className="mt-4 border-t border-gray-100 pt-4">
            <div className="flex items-center gap-2 mb-2 text-xs">
              <span className={`px-2 py-0.5 rounded-full font-medium ${result.mode === 'ai' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-700'}`}>
                {result.mode === 'ai' ? 'AI answer, citations verified' : 'Extractive'}
              </span>
              {result.note && <span className="text-gray-500">{result.note}</span>}
            </div>
            {result.notFound ? (
              <p className="text-sm text-gray-700">Not found in the documents.</p>
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
                <button type="button" onClick={() => setShowAllPassages((v) => !v)} className="text-xs text-blue-600 hover:underline">
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
