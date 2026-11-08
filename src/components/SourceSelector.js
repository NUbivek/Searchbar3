import React, { useState } from 'react';
import { HiOutlineChevronDown, HiOutlineChevronUp, HiOutlineLink, HiOutlineArrowUpTray } from 'react-icons/hi2';
import { uploadFiles } from '../utils/fileHandlers';

export default function SourceSelector({
  mode = 'open',
  selectedSources = [],
  onSourceToggle,
  setSelectedSources,
  onCustomSourceAdd,
  onFileUpload,
  isLoading = false
}) {
  const [customUrl, setCustomUrl] = useState('');
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [customUrlError, setCustomUrlError] = useState('');
  const [fileUploadError, setFileUploadError] = useState('');
  const [showCustomOptions, setShowCustomOptions] = useState(false);

  const sources = {
    open: [
      { id: 'Curated', name: 'Curated sources' },
      { id: 'Web', name: 'Web' },
      { id: 'LinkedIn', name: 'LinkedIn' },
      { id: 'X', name: 'X' },
      { id: 'Reddit', name: 'Reddit' },
      { id: 'Substack', name: 'Substack' },
      { id: 'Medium', name: 'Medium' },
      { id: 'Crunchbase', name: 'Crunchbase' },
      { id: 'Pitchbook', name: 'Pitchbook' },
      { id: 'Carta', name: 'Carta' },
      { id: 'Verified', name: 'Verified' },
    ],
    verified: [
      { id: 'LinkedIn', name: 'LinkedIn' },
      { id: 'X', name: 'X' },
      { id: 'Reddit', name: 'Reddit' },
      { id: 'Carta', name: 'Carta' },
    ]
  };

  const toggleSource = (sourceId) => {
    if (typeof onSourceToggle === 'function') {
      onSourceToggle(sourceId);
      return;
    }

    if (typeof setSelectedSources === 'function') {
      if (selectedSources.includes(sourceId)) {
        setSelectedSources(selectedSources.filter((source) => source !== sourceId));
      } else {
        setSelectedSources([...selectedSources, sourceId]);
      }
    }
  };

  const handleUrlSubmit = (e) => {
    e.preventDefault();
    if (!customUrl) return;

    try {
      // Simple URL validation
      new URL(customUrl);
      if (typeof onCustomSourceAdd === 'function') {
        onCustomSourceAdd(customUrl);
      }
      setCustomUrl('');
      setCustomUrlError('');
    } catch (err) {
      setCustomUrlError('Please enter a valid URL');
    }
  };

  const handleFileUpload = async (files) => {
    if (files && files.length && typeof onFileUpload === 'function') {
      const rawFiles = Array.from(files);
      setSelectedFiles([...selectedFiles, ...rawFiles]);
      setFileUploadError('');

      try {
        const response = await uploadFiles(rawFiles, () => {});
        const parsedFiles = Array.isArray(response?.files) ? response.files : [];
        onFileUpload(parsedFiles);
      } catch (error) {
        console.error('Upload error:', error);
        setFileUploadError(error.response?.data?.error || error.response?.data?.details || error.message || 'Upload failed');
      }
    }
  };

  const CustomSourcesSection = () => (
    <div className="mt-3 rounded-xl border border-line bg-canvas p-4 animate-fadeIn">
      <div className="eyebrow mb-2">Custom sources</div>

      <div className="mb-3">
        <form onSubmit={handleUrlSubmit} className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <HiOutlineLink className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" style={{ width: 16, height: 16 }} />
            <input
              type="text"
              placeholder="Add website URL"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              className="input pl-9"
              disabled={isLoading}
            />
          </div>
          <button
            type="submit"
            className="btn-secondary"
            disabled={isLoading}
          >
            Add
          </button>
        </form>
        {customUrlError && <p className="mt-1 text-sm text-rose-600">{customUrlError}</p>}
      </div>

      <div>
        <label className="mb-1 flex items-center gap-1.5 text-sm font-medium text-ink">
          <HiOutlineArrowUpTray className="text-muted" style={{ width: 15, height: 15 }} />
          Upload files
        </label>
        <input
          type="file"
          multiple
          onChange={(e) => handleFileUpload(e.target.files)}
          className="block w-full text-sm text-muted
            file:mr-3 file:rounded-xl file:border file:border-line file:bg-white
            file:px-3.5 file:py-2 file:text-sm file:font-medium file:text-ink
            hover:file:bg-slate-50 file:transition"
          disabled={isLoading}
        />
        {fileUploadError && <p className="mt-1 text-sm text-rose-600">{fileUploadError}</p>}
      </div>
    </div>
  );

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {sources[mode].map(source => {
          const active = selectedSources.includes(source.id);
          return (
            <button
              key={source.id}
              type="button"
              onClick={() => toggleSource(source.id)}
              disabled={isLoading}
              aria-pressed={active}
              className={`chip ${active ? 'chip-active' : 'hover:border-slate-300 hover:text-ink'} disabled:opacity-50`}
            >
              {source.name}
            </button>
          );
        })}
        {mode === 'open' && (typeof onCustomSourceAdd === 'function' || typeof onFileUpload === 'function') && (
          <button
            type="button"
            onClick={() => setShowCustomOptions(!showCustomOptions)}
            className={`chip ${showCustomOptions ? 'chip-active' : 'hover:border-slate-300 hover:text-ink'} disabled:opacity-50`}
            disabled={isLoading}
            aria-expanded={showCustomOptions}
          >
            Custom
            {showCustomOptions
              ? <HiOutlineChevronUp style={{ width: 13, height: 13 }} />
              : <HiOutlineChevronDown style={{ width: 13, height: 13 }} />}
          </button>
        )}
      </div>

      {mode === 'open' && showCustomOptions && <CustomSourcesSection />}
    </div>
  );
}
