import React, { useState } from 'react';
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

  const removeUrl = (urlToRemove) => {
    // This would require a callback from the parent component
    console.log('Would remove URL:', urlToRemove);
  };

  const removeFile = (fileToRemove) => {
    // This would require a callback from the parent component
    console.log('Would remove file:', fileToRemove);
  };

  const CustomSourcesSection = () => (
    <div className="mt-4 p-4 border border-gray-200 rounded-md">
      <h3 className="text-md font-medium mb-2">Custom Sources</h3>
      
      <div className="mb-3">
        <form onSubmit={handleUrlSubmit} className="flex">
          <input
            type="text"
            placeholder="Add website URL"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            className="flex-grow p-2 border border-gray-300 rounded-l-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isLoading}
          />
          <button
            type="submit"
            className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-r-md disabled:opacity-50"
            disabled={isLoading}
          >
            Add
          </button>
        </form>
        {customUrlError && <p className="text-red-500 text-sm mt-1">{customUrlError}</p>}
      </div>
      
      <div className="mb-3">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Upload Files
        </label>
        <input
          type="file"
          multiple
          onChange={(e) => handleFileUpload(e.target.files)}
          className="block w-full text-sm text-gray-500
            file:mr-4 file:py-2 file:px-4
            file:rounded-md file:border-0
            file:text-sm file:font-semibold
            file:bg-blue-50 file:text-blue-700
            hover:file:bg-blue-100"
          disabled={isLoading}
        />
        {fileUploadError && <p className="text-red-500 text-sm mt-1">{fileUploadError}</p>}
      </div>
    </div>
  );

  return (
    <div>
      <div className="flex flex-wrap gap-2 mt-2 justify-center">
        {sources[mode].map(source => (
          <button
            key={source.id}
            onClick={() => toggleSource(source.id)}
            disabled={isLoading}
            className={`px-3 py-1 text-sm rounded-md border ${
              selectedSources.includes(source.id)
                ? 'bg-blue-500 text-white border-blue-500'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
            } disabled:opacity-50`}
          >
            {source.name}
          </button>
        ))}
        {mode === 'open' && (typeof onCustomSourceAdd === 'function' || typeof onFileUpload === 'function') && (
          <button
            onClick={() => setShowCustomOptions(!showCustomOptions)}
            className="px-3 py-1 text-sm rounded-md border bg-white text-gray-700 border-gray-300 hover:bg-gray-100"
            disabled={isLoading}
          >
            Custom {showCustomOptions ? '▲' : '▼'}
          </button>
        )}
      </div>
      
      {mode === 'open' && showCustomOptions && <CustomSourcesSection />}
    </div>
  );
}
