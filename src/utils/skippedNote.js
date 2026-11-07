/** " · gemini-3.8-flash skipped (rate limited)" for the answer provenance line. */
export function skippedNote(skipped) {
  if (!Array.isArray(skipped) || skipped.length === 0) return '';
  const first = skipped.slice(0, 2).map((s) => `${String(s.model).split('/').pop().replace(/:free$/, '')} (${s.why})`).join(', ');
  return ` · Skipped: ${first}${skipped.length > 2 ? ` and ${skipped.length - 2} more` : ''}`;
}
