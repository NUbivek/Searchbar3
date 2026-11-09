import React, { useEffect, useState } from 'react';

/**
 * AI model menu. Lists only models that are available right now (from
 * /api/llm/models): "Auto" picks the best available model and falls back down
 * the chain. With no model available, answers are quoted summaries.
 */
const ModelSelector = ({ selectedModel, onChange, className = '' }) => {
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
      className={`select ${className}`}
      aria-label="Select AI model"
      title={none ? 'Answers are quoted directly from sources on this deployment.' : 'AI model used to write the answer'}
    >
      <option value="auto">{models === null ? 'AI: loading…' : none ? 'Quoted from sources' : 'AI: Auto'}</option>
      {(models || []).map((m) => (
        <option key={m.id} value={m.id}>{m.label}</option>
      ))}
    </select>
  );
};

export default ModelSelector;
