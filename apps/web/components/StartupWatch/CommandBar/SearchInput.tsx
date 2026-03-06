import React from 'react';

export function SearchInput({ value = '', onChange }: { value?: string; onChange: (v: string) => void }) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => setLocal(value), [value]);
  React.useEffect(() => {
    const t = setTimeout(() => onChange(local), 300);
    return () => clearTimeout(t);
  }, [local, onChange]);
  return (
    <input
      className="border rounded px-3 py-2 text-sm w-full"
      placeholder="Search startups..."
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setLocal('');
        if (e.key === 'Enter') onChange(local);
      }}
    />
  );
}
