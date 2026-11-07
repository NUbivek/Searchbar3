/**
 * Build Network Map graph data from contacts: "You" at the centre, one node
 * per company (sized by number of contacts) and one node per person.
 * Large networks (more than `maxPeople`) show company nodes only; a company's
 * people appear when it is expanded.
 */
import { normalizeCompanyKey, dedupeKey } from './parseContacts';

export const NO_COMPANY_KEY = '__none__';
export const personNodeId = (contact) => `p:${dedupeKey(contact)}`;
export const companyNodeId = (key) => `c:${key}`;

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

export function buildGraph(contacts, { expanded = new Set(), maxPeople = 1500, maxCompanies = 400, meLabel = 'You' } = {}) {
  const list = contacts || [];
  const groups = groupByCompany(list);
  const large = list.length > maxPeople;
  const shown = large ? groups.slice(0, maxCompanies) : groups;
  const nodes = [{ id: 'me', type: 'me', label: meLabel, r: 8, fx: 0, fy: 0 }];
  const links = [];
  let peopleShown = 0;
  shown.forEach((g, rank) => {
    const cid = companyNodeId(g.key);
    const count = g.contacts.length;
    nodes.push({
      id: cid,
      type: 'company',
      key: g.key,
      label: g.label,
      count,
      r: large ? Math.min(2 + Math.sqrt(count) * 1.2, 16) : Math.min(3 + Math.sqrt(count) * 1.6, 22),
      tooltip: `${g.label}: ${count} ${count === 1 ? 'person' : 'people'}`,
      // Label only the largest companies by default; the rest on zoom/hover.
      labelled: rank < 30,
    });
    links.push({ source: 'me', target: cid, kind: 'me' });
    if (!large || expanded.has(g.key)) {
      for (const c of g.contacts) {
        const pid = personNodeId(c);
        nodes.push({
          id: pid,
          type: 'person',
          label: c.name,
          source: c.source,
          companyKey: g.key,
          contact: c,
          r: 2.5,
          tooltip: [c.name, c.position, c.company].filter(Boolean).join(' · '),
        });
        links.push({ source: cid, target: pid, kind: 'company' });
        peopleShown += 1;
      }
    }
  });
  return {
    nodes,
    links,
    large,
    companyCount: groups.length,
    hiddenCompanies: groups.length - shown.length,
    peopleShown,
  };
}
