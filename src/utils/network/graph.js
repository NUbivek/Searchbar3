/**
 * Build Network Map graph data from contacts: "You" at the centre, one node
 * per company (sized by number of contacts) and one node per person.
 * Large networks (more than `maxPeople`) show company nodes only; a company's
 * people appear when it is expanded.
 */
import { normalizeCompanyKey, dedupeKey } from './parseContacts';
import { bucketsFor } from './grouping';

export const NO_COMPANY_KEY = '__none__';
/** Folded one-person companies in a hub layer. */
export const SMALL_COMPANIES_KEY = '__small__';
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
  const biggest = buckets.reduce((m, b) => Math.max(m, b.contacts.length), 0);
  const hubRadius = 220 + Math.sqrt(biggest) * 10;
  buckets.forEach((b, i) => {
    let gs = groupByCompany(b.contacts).map((g) => ({ ...g, hub: b.key }));
    // In hub layers, one-person companies are folded into a single node per
    // hub so the layer shows its real clusters, not a fringe of singletons.
    if (byRole) {
      const small = gs.filter((g) => g.contacts.length < 3 && g.key !== NO_COMPANY_KEY);
      if (small.length > 3) {
        gs = gs.filter((g) => !small.includes(g));
        gs.push({ key: SMALL_COMPANIES_KEY, label: `${small.length} other companies`, contacts: small.flatMap((g) => g.contacts), hub: b.key, folded: small.length });
      }
    }
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

  // With hubs, companies get fixed places on rings around their hub (largest
  // first, on the side facing away from the centre) so every layer reads the
  // same way; only people move. Without hubs the force layout places them.
  const placed = new Map();
  if (byRole) {
    const hubAngle = new Map();
    buckets.forEach((b, i) => hubAngle.set(b.key, (2 * Math.PI * i) / buckets.length - Math.PI / 2));
    for (const b of buckets) {
      const mine = shown.filter((g) => g.hub === b.key);
      const hubX = Math.cos(hubAngle.get(b.key)) * hubRadius;
      const hubY = Math.sin(hubAngle.get(b.key)) * hubRadius;
      let start = 0;
      let ring = 0;
      while (start < mine.length) {
        const capacity = 6 + ring * 6;
        const slice = mine.slice(start, start + capacity);
        const roomiest = Math.sqrt(slice[0]?.contacts.length || 1);
        const radius = 150 + ring * 95 + roomiest * 4;
        const arc = ring === 0 ? Math.PI * 1.1 : Math.PI * 1.4;
        slice.forEach((g, j) => {
          const angle = hubAngle.get(b.key) - arc / 2 + ((j + 0.5) * arc) / slice.length;
          placed.set(companyNodeId(g.key, g.hub), { fx: hubX + Math.cos(angle) * radius, fy: hubY + Math.sin(angle) * radius });
        });
        start += capacity;
        ring += 1;
      }
    }
  }

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
      r: byRole ? Math.min(2.5 + Math.sqrt(count) * 1.1, 13) : large ? Math.min(2 + Math.sqrt(count) * 1.2, 16) : Math.min(3 + Math.sqrt(count) * 1.6, 22),
      tooltip: `${g.label}: ${count} ${count === 1 ? 'person' : 'people'}${hiddenPeople ? ` (${people.length} drawn)` : ''}`,
      // Label only the largest companies by default; the rest on zoom/hover.
      labelled: rank < 30,
      shownPeople: people.length,
      hiddenPeople,
      ...(placed.get(cid) || {}),
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
