/**
 * Export a workspace as an investment memo: Word, Markdown, or PDF (opens the
 * print-optimized memo page, which triggers the browser's Save as PDF).
 */
import React from 'react';
import Link from 'next/link';

const primary = 'inline-block bg-blue-500 hover:bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium';
const secondary = 'inline-block bg-white border border-gray-300 hover:border-blue-400 hover:text-blue-700 text-gray-700 px-3 py-1.5 rounded-md text-sm font-medium';

export default function MemoExportButtons({ workspaceId, className = '' }) {
  if (!workspaceId) return null;
  const id = encodeURIComponent(workspaceId);
  const api = `/api/workspaces/${id}/memo`;
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`} role="group" aria-label="Export investment memo">
      <a href={`${api}?format=docx`} download className={primary}>Download Word</a>
      <a href={`${api}?format=md`} download className={secondary}>Download Markdown</a>
      <Link href={`/workspaces/${id}/memo?print=1`} className={secondary}>Save as PDF</Link>
      <Link href={`/workspaces/${id}/memo`} className="text-sm text-blue-600 hover:text-blue-800 px-1">Preview memo</Link>
    </div>
  );
}
