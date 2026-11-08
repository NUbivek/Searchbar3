/**
 * Export a workspace as an investment memo: Word, Markdown, or PDF (opens the
 * print-optimized memo page, which triggers the browser's Save as PDF).
 */
import React from 'react';
import Link from 'next/link';
import { HiOutlineDocumentArrowDown } from 'react-icons/hi2';

const primary = 'btn-primary px-3 py-2 text-xs';
const secondary = 'btn-secondary px-3 py-2 text-xs';

export default function MemoExportButtons({ workspaceId, className = '' }) {
  if (!workspaceId) return null;
  const id = encodeURIComponent(workspaceId);
  const api = `/api/workspaces/${id}/memo`;
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`} role="group" aria-label="Export investment memo">
      <a href={`${api}?format=docx`} download className={primary}><HiOutlineDocumentArrowDown style={{ width: 14, height: 14 }} /> Download Word</a>
      <a href={`${api}?format=md`} download className={secondary}>Download Markdown</a>
      <Link href={`/workspaces/${id}/memo?print=1`} className={secondary}>Save as PDF</Link>
      <Link href={`/workspaces/${id}/memo`} className="btn-ghost text-xs">Preview memo</Link>
    </div>
  );
}
