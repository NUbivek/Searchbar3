/**
 * Build Network Map graph data from contacts: "You" at the centre, one node
 * per company (sized by number of contacts) and one node per person.
 * Large networks (more than `maxPeople`) show company nodes only; a company's
 * people appear when it is expanded.
 */
import { normalizeCompanyKey, dedupeKey } from './parseContacts';
import { bucketsFor } from './grouping';

export const NO_COMPANY_KEY = '__none__';
/** People drawn for one expanded company in a large network; the rest stay in the details list. */
export const MAX_PEOPLE_PER_EXPANDED_COMPANY = 150;
export const personNodeId = (contact) => `p:${dedupeKey(contact)}`;
export const companyNodeId = (key, group) => (group ? `c:${group}:${key}` : `c:${key}`);
export const groupNodeId = (group) => `g:${group}`;

/** Group contacts by normalised company. Returns [{ key, label, contacts }] largest first. */
export function groupByCompany(contacts) {
  const groups = new Map();
  for (const c of contacts || []) {
    const key = normalizeCompanyKey(c.company) || NO_COMPANY_KEY;
    let g = groups.get(key);
    if (!g) {
      g = { key, label: key === NO_COMPANY_KEY ? 'No company listed' : c.company, contacts: [], labels: new Map() };
      groups.set(key, g);
    }
    g.contacts.push(c);
    if (key !== NO_COMPANY_KEY) g.labels.set(c.company, (g.labels.get(c.company) || 0) + 1);
  }
  const list = [...groups.values()].map((g) => {
    // Display the most common spelling ("Stripe" over "Stripe, Inc.")
    let label = g.label;
    let best = 0;
    for (const [name, n] of g.labels) if (n > best) { best = n; label = name; }
    return { key: g.key, label, contacts: g.contacts };
  });
  list.sort((a, b) => b.contacts.length - a.contacts.length || a.label.localeCompare(b.label));
  return list;
}

export function buildGraph(contacts, {
  expanded = new Set(), maxPeople = 1500, maxCompanies = 400, meLabel = 'You', maxPerCompany = MAX_PEOPLE_PER_EXPANDED_COMPANY,
  groupBy = 'company',
} = {}) {
  const list = contacts || [];
  const large = list.length > maxPeople;
  const nodes = [{ id: 'me', type: 'me', label: meLabel, r: 8, fx: 0, fy: 0 }];
  const links = [];
  let peopleShown = 0;
  const cappedCompanies = [];
  // Hubs (by role, industry or country) sit between "you" and the
  // companies, and a company appears once per hub it has people in.
  const byRole = groupBy !== 'company';
  const buckets = bucketsFor(list, groupBy);
  let groups = [];
  // Hubs are pinned on a ring around "you" so the map always reads as the
  // same quadrants; only the companies and people move.
  const hubRadius = 380 + Math.sqrt(list.length) * 4;
  buckets.forEach((b, i) => {
    const gs = groupByCompany(b.contacts).map((g) => ({ ...g, hub: b.key }));
    if (byRole) {
      const angle = (2 * Math.PI * i) / buckets.length - Math.PI / 2;
      nodes.push({
        id: groupNodeId(b.key), type: 'group', key: b.key, label: b.label, hint: b.hint, lens: b.lens, count: b.contacts.length,
        r: Math.min(10 + Math.sqrt(b.contacts.length) * 1.4, 26), tooltip: `${b.label}: ${b.contacts.length} people. ${b.hint}`,
        fx: Math.cos(angle) * hubRadius, fy: Math.sin(angle) * hubRadius,
      });
      links.push({ source: 'me', target: groupNodeId(b.key), kind: 'me' });
    }
    groups = groups.concat(gs);
  });
  groups.sort((a, b) => b.contacts.length - a.contacts.length || a.label.localeCompare(b.label));
  const shown = large ? groups.slice(0, maxCompanies) : groups;
  shown.forEach((g, rank) => {
    const cid = companyNodeId(g.key, g.hub);
    const count = g.contacts.length;
    const isExpanded = large && expanded.has(g.key);
    // In a large network an expanded company shows at most `maxPerCompany`
    // people (sorted by name) so one big employer cannot swamp the canvas.
    const people = !large ? g.contacts
      : isExpanded ? [...g.contacts].sort((a, b) => a.name.localeCompare(b.name)).slice(0, maxPerCompany) : [];
    const hiddenPeople = isExpanded ? count - people.length : 0;
    if (hiddenPeople > 0) cappedCompanies.push({ key: g.key, label: g.label, shown: people.length, hidden: hiddenPeople });
    nodes.push({
      id: cid,
      type: 'company',
      key: g.key,
      hub: g.hub,
      label: g.label,
      count,
      r: large ? Math.min(2 + Math.sqrt(count) * 1.2, 16) : Math.min(3 + Math.sqrt(count) * 1.6, 22),
      tooltip: `${g.label}: ${count} ${count === 1 ? 'person' : 'people'}${hiddenPeople ? ` (${people.length} drawn)` : ''}`,
      // Label only the largest companies by default; the rest on zoom/hover.
      labelled: rank < 30,
      shownPeople: people.length,
      hiddenPeople,
    });
    links.push({ source: g.hub ? groupNodeId(g.hub) : 'me', target: cid, kind: g.hub ? 'group' : 'me' });
    for (const c of people) {
      const pid = personNodeId(c);
      nodes.push({
        id: pid,
        type: 'person',
        label: c.name,
        source: c.source,
        companyKey: g.key,
        companyId: cid,
        hub: g.hub,
        contact: c,
        r: 2.5,
        tooltip: [c.name, c.position, c.company].filter(Boolean).join(' · '),
      });
      links.push({ source: cid, target: pid, kind: 'company' });
      peopleShown += 1;
    }
  });
  return {
    nodes,
    links,
    large,
    groupBy,
    companyCount: new Set(groups.map((g) => g.key)).size,
    hiddenCompanies: groups.length - shown.length,
    peopleShown,
    cappedCompanies,
  };
}
