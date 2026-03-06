import React from 'react';
export default function FlagToggle({ flagged=false, onToggle }: { flagged?: boolean; onToggle?: () => void }) {
  return <button onClick={onToggle} className="text-lg">{flagged ? '★' : '☆'}</button>;
}
