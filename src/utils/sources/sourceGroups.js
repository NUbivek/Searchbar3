/**
 * Site-restricted source groups for Open Research: many official or
 * institutional domains searched as one toggle. Each group runs a few
 * `site:a OR site:b` web queries (chunked so the query stays short) and
 * every hit is tiered by its host (government = filing / official,
 * institutions = reputable report).
 */

export const SOURCE_GROUPS = {
  government: {
    key: 'government',
    label: 'Government & regulators',
    hint: 'SEC, Federal Reserve and FRED, FDIC, OCC, CFPB, FTC, DOJ, CMS, FDA, USPTO, Census, BLS, Treasury, state registries, UK and EU regulators',
    tier: 'filing',
    domains: [
      // US federal: securities, banking, consumer, competition
      'sec.gov', 'federalreserve.gov', 'fred.stlouisfed.org', 'stlouisfed.org', 'newyorkfed.org', 'fdic.gov', 'occ.gov', 'occ.treas.gov', 'treasury.gov', 'cfpb.gov', 'ftc.gov', 'justice.gov', 'finra.org', 'cftc.gov', 'fincen.gov',
      // US federal: health, science, IP, trade, labour, statistics
      'cms.gov', 'fda.gov', 'hhs.gov', 'nih.gov', 'cdc.gov', 'commerce.gov', 'census.gov', 'bls.gov', 'bea.gov', 'sba.gov', 'energy.gov', 'epa.gov', 'fcc.gov', 'dol.gov', 'gao.gov', 'cbo.gov', 'govinfo.gov', 'data.gov', 'usaspending.gov', 'sam.gov', 'whitehouse.gov', 'congress.gov',
      // State business registries and attorneys general
      'opencorporates.com', 'sos.ca.gov', 'bizfileonline.sos.ca.gov', 'dos.ny.gov', 'sos.state.tx.us', 'icis.corp.delaware.gov', 'corp.delaware.gov', 'sos.la.gov', 'ag.ny.gov', 'oag.ca.gov',
      // UK and EU
      'find-and-update.company-information.service.gov.uk', 'companieshouse.gov.uk', 'fca.org.uk', 'bankofengland.co.uk', 'ons.gov.uk', 'europa.eu', 'ecb.europa.eu', 'esma.europa.eu', 'eba.europa.eu', 'ema.europa.eu',
    ],
  },
  ip: {
    key: 'ip',
    label: 'Patents, IP & research agencies',
    hint: 'USPTO, Google Patents, Copyright Office, WIPO, EPO, UK IPO; DARPA, ARPA-E, IARPA, NSF, NIST, NASA, NIH RePORTER, SBIR/STTR awards',
    tier: 'filing',
    domains: [
      // Patents, trademarks, copyright
      'uspto.gov', 'ppubs.uspto.gov', 'patentcenter.uspto.gov', 'tsdr.uspto.gov', 'patents.google.com', 'copyright.gov', 'wipo.int', 'patentscope.wipo.int', 'epo.org', 'register.epo.org', 'ipo.gov.uk', 'euipo.europa.eu', 'cipo.ic.gc.ca', 'jpo.go.jp', 'freepatentsonline.com', 'lens.org', 'justia.com',
      // Research and defence funding agencies
      'darpa.mil', 'arpa-e.energy.gov', 'iarpa.gov', 'nsf.gov', 'nist.gov', 'nasa.gov', 'reporter.nih.gov', 'sbir.gov', 'grants.gov', 'afwerx.com', 'diu.mil', 'ukri.org', 'innovateuk.ukri.org', 'horizon-europe.ec.europa.eu',
    ],
  },
  institutions: {
    key: 'institutions',
    label: 'Institutions & research',
    hint: 'UN, World Bank, IMF, OECD, WHO, WEF; McKinsey, BCG, Bain, Big Four, Gartner, Forrester; Brookings, RAND, Pew, NBER, CFR; SSRN, arXiv, CB Insights, Statista',
    tier: 'press',
    domains: [
      // Multilateral
      'un.org', 'worldbank.org', 'imf.org', 'oecd.org', 'who.int', 'wto.org', 'bis.org', 'weforum.org', 'undp.org', 'unctad.org', 'ifc.org', 'adb.org', 'ebrd.com',
      // Consulting and advisory
      'mckinsey.com', 'bcg.com', 'bain.com', 'deloitte.com', 'pwc.com', 'ey.com', 'kpmg.com', 'accenture.com', 'oliverwyman.com', 'kearney.com', 'strategyand.pwc.com', 'gartner.com', 'forrester.com', 'idc.com',
      // Think tanks and research
      'brookings.edu', 'rand.org', 'pewresearch.org', 'cfr.org', 'nber.org', 'piie.com', 'aei.org', 'csis.org', 'urban.org', 'chathamhouse.org', 'bruegel.org', 'epi.org', 'hoover.org', 'milkeninstitute.org',
      // Papers, data and industry research
      'ssrn.com', 'arxiv.org', 'cbinsights.com', 'statista.com', 'hbr.org', 'sloanreview.mit.edu', 'knowledge.wharton.upenn.edu', 'gsb.stanford.edu', 'hbs.edu',
    ],
  },
};

export const SOURCE_GROUP_KEYS = Object.keys(SOURCE_GROUPS);

const CHUNK = 8;

/** The `site:` queries for a group: domains chunked so each query stays within search-engine limits. */
export function groupQueries(groupKey, query) {
  const group = SOURCE_GROUPS[groupKey];
  if (!group) return [];
  const q = String(query || '').trim();
  const out = [];
  for (let i = 0; i < group.domains.length; i += CHUNK) {
    const sites = group.domains.slice(i, i + CHUNK).map((d) => `site:${d}`).join(' OR ');
    out.push(`${q} (${sites})`);
  }
  return out;
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

/** True when the host belongs to the group (the domain or a subdomain of it). */
export function hostInGroup(url, groupKey) {
  const group = SOURCE_GROUPS[groupKey];
  const host = hostOf(url);
  if (!group || !host) return false;
  return group.domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Which group (if any) a URL belongs to. */
export function groupOfUrl(url) {
  for (const key of SOURCE_GROUP_KEYS) if (hostInGroup(url, key)) return key;
  return null;
}
