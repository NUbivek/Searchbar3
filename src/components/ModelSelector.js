import React, { useEffect, useState } from 'react';

/**
 * AI model menu. Lists only models that are available right now (from
 * /api/llm/models): "Auto" picks the best free model and falls back down the
 * chain. With no model configured, answers are quoted summaries.
 */
const ModelSelector = ({ selectedModel, onChange }) => {
  const [models, setModels] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/llm/models')
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((d) => { if (!cancelled) setModels(d.models || []); })
      .catch(() => { if (!cancelled) setModels([]); });
    return () => { cancelled = true; };
  }, []);

  // Old saved values (e.g. "mistral-7b") are no longer served: use Auto
  useEffect(() => {
    if (models && selectedModel !== 'auto' && !models.some((m) => m.id === selectedModel)) onChange('auto');
  }, [models, selectedModel, onChange]);

  const none = models && models.length === 0;
  return (
    <select
      id="model-selector"
      value={models && models.some((m) => m.id === selectedModel) ? selectedModel : 'auto'}
      onChange={(e) => onChange(e.target.value)}
      className="w-full h-full px-2 py-2 bg-transparent border-none focus:outline-none focus:ring-0 text-gray-700 text-sm"
      aria-label="Select AI model"
      title={none ? 'No AI model is configured: answers are quoted from sources. Add a free GROQ_API_KEY or OPENROUTER_API_KEY.' : 'AI model used to write the answer'}
    >
      <option value="auto">{models === null ? 'AI: loading…' : none ? 'AI: quoted only' : 'AI: Auto (best free)'}</option>
      {(models || []).map((m) => (
        <option key={m.id} value={m.id}>{m.label}</option>
      ))}
    </select>
  );
};

export default ModelSelector;
