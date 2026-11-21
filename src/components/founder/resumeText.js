/** Plain-text helpers for the résumé lines of a deep report (shared by the page and "Copy as text"). */

/** "2019 – present", "2015 – 2017", "2015", "until 2017", or nothing when the record gives no years. */
export function yearsOf({ from = null, to = null, current = false } = {}) {
  if (from && (to || current)) return `${from} – ${current && !to ? 'present' : to}`;
  if (from) return String(from);
  if (to) return `until ${to}`;
  return current ? 'present' : '';
}

/** Current roles first, then the latest start (or end) first; roles with no years keep their order at the end. */
export function sortRoles(roles) {
  const when = (r) => Number(r.from) || Number(r.to) || 0;
  return (Array.isArray(roles) ? roles : [])
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(Boolean(b.r.current)) - Number(Boolean(a.r.current)) || when(b.r) - when(a.r) || a.i - b.i)
    .map(({ r }) => r);
}
