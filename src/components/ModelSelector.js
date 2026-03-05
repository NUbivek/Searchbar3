import React from 'react';

// Model options with display names - using standardized model IDs
const MODEL_OPTIONS = [
  { id: 'mistral-7b', name: 'Mistral 7B' },
  { id: 'llama-13b', name: 'Llama 2 13B' },
  { id: 'gemma-27b', name: 'Gemma 27B' },
  { id: 'deepseek-free', name: 'DeepSeek (Free)' }
];

const ModelSelector = ({ selectedModel, onChange }) => {
  return (
    <select
      id="model-selector"
      value={selectedModel}
      onChange={e => onChange(e.target.value)}
      className="w-full h-full px-2 py-2 bg-transparent border-none focus:outline-none focus:ring-0 text-gray-700 text-sm"
      aria-label="Select AI model"
    >
      {MODEL_OPTIONS.map(model => (
        <option key={model.id} value={model.id}>
          {model.name}
        </option>
      ))}
    </select>
  );
};

export default ModelSelector;
