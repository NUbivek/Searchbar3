/**
 * Who is this contact to an investor? Deterministic classification of a
 * contact from its title and company into a role, and from the role into
 * the "lenses" a fund's managing partner cares about:
 *
 *   raise      people who can put money in or open the door to it:
 *              LPs (family offices, endowments, pensions, funds of funds,
 *              wealth managers), investors (VCs, angels, co-investors)
 *   source     people who see deals first: founders, operators at startups,
 *              accelerators, investors, startup lawyers and bankers
 *   diligence  people who can vet a company or founder: domain experts and
 *              operators in the sector, former colleagues, customers,
 *              researchers, consultants, lawyers, accountants, bankers
 *
 * Nothing here calls a model; it is the same regex vocabulary on the server
 * (ask your network) and in the browser (the map).
 */

export const LENSES = {
  raise: { key: 'raise', label: 'Raise capital', short: 'Raise', description: 'LPs, investors and the people who can introduce you to them.' },
  source: { key: 'source', label: 'Source deals', short: 'Source', description: 'Founders, operators, accelerators and co-investors who see deals first.' },
  diligence: { key: 'diligence', label: 'Diligence', short: 'Diligence', description: 'Experts, operators, former colleagues and advisors who can vet a company or founder.' },
};
export const LENS_KEYS = ['raise', 'source', 'diligence'];

/** Role vocabulary, most specific first. `title` tests the position, `company` the employer. */
export const ROLES = [
  {
    key: 'lp', label: 'LP / allocator', group: 'Investors & LPs', lenses: ['raise'],
    title: /\b(limited partner|lp\b|allocator|family office|endowment|pension|fund of funds|fof|sovereign|wealth manag\w*|private bank\w*|investment committee|chief investment officer|cio\b|portfolio manager|capital formation|investor relations|placement agent|foundation)\b/i,
    company: /\b(family office|endowment|pension|foundation|fund of funds|sovereign|wealth|private bank|asset management|capital management|investment management|trust company|insurance)\b/i,
  },
  {
    key: 'investor', label: 'Investor', group: 'Investors & LPs', lenses: ['raise', 'source'],
    title: /\b(general partner|managing partner|venture partner|operating partner|partner|principal|associate|analyst|investor|investing|investment|venture|vc\b|angel|scout|fund|seed|growth equity|private equity|pe\b)\b/i,
    company: /\b(capital|ventures?|partners|vc\b|fund|angels?|seed|equity|investments?|holdings|accelerator|incubator|y combinator|techstars|500 ?(global|startups)|sequoia|andreessen|a16z|accel|benchmark|greylock|kleiner|lightspeed|khosla|bessemer|nea|founders fund|general catalyst|insight partners|tiger global|coatue|softbank|first round|redpoint|ivp|gv)\b/i,
    requireCompanyIf: /\b(partner|principal|associate|analyst|fund|investment)\b/i,
  },
  {
    key: 'accelerator', label: 'Accelerator / platform', group: 'Founders & operators', lenses: ['source'],
    title: /\b(accelerator|incubator|program (director|manager)|community|platform|ecosystem|startup program)\b/i,
    company: /\b(y combinator|techstars|500 ?(global|startups)|accelerator|incubator|founders? (institute|network)|launchpad|skydeck|alchemist|entrepreneur first|antler)\b/i,
  },
  {
    key: 'founder', label: 'Founder', group: 'Founders & operators', lenses: ['source', 'diligence'],
    title: /\b(co-?founder|founder|founding|owner|ceo|chief executive|(?<!vice )(?<!senior vice )(?<!executive vice )president|entrepreneur in residence|eir|stealth|building something)\b/i,
  },
  {
    key: 'banker', label: 'Banker / M&A', group: 'Experts & advisors', lenses: ['source', 'diligence', 'raise'],
    title: /\b(investment bank\w*|banker|m&a|mergers|capital markets|corporate development|corp dev|equity research)\b/i,
    company: /\b(goldman|morgan stanley|jp ?morgan|j\.p\. morgan|evercore|lazard|moelis|jefferies|piper sandler|qatalyst|allen & co|raymond james|houlihan|centerview|perella|guggenheim|baird|william blair|rothschild|ubs|barclays|citi|credit suisse|deutsche bank|bank of america|bofa|wells fargo|svb|silicon valley bank)\b/i,
  },
  {
    key: 'lawyer', label: 'Lawyer', group: 'Experts & advisors', lenses: ['diligence', 'source'],
    title: /\b(lawyer|attorney|counsel|solicitor|barrister|legal|paralegal)\b/i,
    company: /\b(cooley|wilson sonsini|wsgr|gunderson|fenwick|latham|orrick|goodwin|perkins coie|dla piper|kirkland|skadden|sullivan|morrison foerster|mofo|law (firm|group|offices?)|llp\b|legal)\b/i,
  },
  {
    key: 'accountant', label: 'Accountant / finance', group: 'Experts & advisors', lenses: ['diligence'],
    title: /\b(cpa|accountant|accounting|audit\w*|controller|tax|fp&a|treasurer|cfo|chief financial|vp,? finance|head of finance|finance director)\b/i,
    company: /\b(deloitte|pwc|pricewaterhouse|kpmg|ernst|ey\b|bdo|grant thornton|accounting|cpa)\b/i,
  },
  {
    key: 'consultant', label: 'Consultant / advisor', group: 'Experts & advisors', lenses: ['diligence'],
    title: /\b(consultant|consulting|advisor|adviser|advisory|strategist|board member|board director|independent director)\b/i,
    company: /\b(mckinsey|bain|bcg|boston consulting|accenture|deloitte|oliver wyman|kearney|strategy&|consulting|advisory)\b/i,
  },
  {
    // Before "academic": an MBA candidate at a university is a student, not a professor.
    key: 'student', label: 'Student / early career', group: 'Founders & operators', lenses: ['source'],
    title: /\b(student|mba candidate|mba student|ph\.?d\.? (candidate|student)|doctoral (candidate|student)|undergraduate|graduate student|intern|internship|trainee|apprentice|class of \d{2,4})\b/i,
  },
  {
    key: 'clinician', label: 'Clinician', group: 'Experts & advisors', lenses: ['diligence'],
    title: /\b(physician|doctor|surgeon|nurse|dentist|pharmacist|therapist|psychologist|psychiatrist|clinician|medical director|chief medical officer)\b/i,
    company: /\b(hospital|clinic|medical center|health system)\b/i,
  },
  {
    key: 'public', label: 'Public sector / policy', group: 'Experts & advisors', lenses: ['diligence'],
    title: /\b(policy|public affairs|government|public sector|diplomat|ambassador|senator|congress\w*|minister|regulat\w*|civil servant|military|veteran)\b/i,
    company: /\b(government|department of|ministry|federal|city of|state of|county of|u\.?s\.? (army|navy|air force|marine)|european commission|united nations|world bank|imf|oecd|nato)\b/i,
  },
  {
    key: 'academic', label: 'Researcher / academic', group: 'Experts & advisors', lenses: ['diligence'],
    title: /\b(professor|lecturer|researcher|research (scientist|fellow|director|lead|engineer)|ph\.?d|postdoc|postdoctoral|dean|faculty|principal investigator)\b/i,
    company: /\b(university|universit[aé]t|college|institute of technology|school of|laboratory|national lab|research (institute|center|centre)|academy)\b/i,
  },
  {
    key: 'press', label: 'Press / analyst', group: 'Experts & advisors', lenses: ['diligence', 'source'],
    title: /\b(journalist|reporter|editor|correspondent|columnist|writer|industry analyst|research analyst|podcast)\b/i,
    company: /\b(techcrunch|the information|bloomberg|reuters|forbes|wall street journal|wsj|financial times|ft\b|new york times|nyt|axios|gartner|forrester|idc\b|cb insights|pitchbook|crunchbase)\b/i,
  },
  {
    // "Partner" at a firm that is not a fund: a law, consulting or accounting partner.
    key: 'partner', label: 'Partner (professional firm)', group: 'Experts & advisors', lenses: ['diligence', 'source'],
    title: /\bpartner\b/i,
  },
  {
    key: 'executive', label: 'Executive', group: 'Founders & operators', lenses: ['source', 'diligence'],
    title: /\b(cto|coo|cmo|cpo|cro|ciso|chief|c-level|vp|vice president|svp|evp|head of|general manager|gm\b|managing director|director)\b/i,
  },
  {
    key: 'operator', label: 'Operator', group: 'Founders & operators', lenses: ['diligence', 'source'],
    title: /\b(engineer\w*|develop\w*|programmer|architect|product|design\w*|ux|ui|data|scientist|market\w*|growth|sales|account\w*|customer|success|support|operations|ops|program|project|manag\w*|lead|leader|staff|senior|junior|principal|analyst|specialist|associate|assistant|coordinator|administrator|admin|officer|representative|recruit\w*|talent|people|hr|human resources|finance|strategy|partnerships?|business development|bd|researcher|technician|technical|supervisor|executive|head|producer|creative|content|brand|communications|procurement|supply chain|logistics|quality|qa|it|member of technical staff|mts)\b/i,
  },
];

// Order is the map's compass: top, right, bottom, left.
export const ROLE_GROUPS = [
  { key: 'investors', label: 'Investors & LPs', hint: 'Who can fund you, co-invest or introduce an LP', lens: 'raise' },
  { key: 'founders', label: 'Founders & operators', hint: 'Who sees deals first and can vouch for a founder', lens: 'source' },
  { key: 'other', label: 'Everyone else', hint: 'No title and no company in the import', lens: null },
  { key: 'experts', label: 'Experts & advisors', hint: 'Who can vet a sector, a company or a founder', lens: 'diligence' },
];
const GROUP_KEY = { 'Investors & LPs': 'investors', 'Founders & operators': 'founders', 'Experts & advisors': 'experts' };

const cache = new WeakMap();

/**
 * Classify one contact. Returns { role, label, group, lenses: string[], reason }.
 * The result is cached per contact object.
 */
export function classifyContact(contact) {
  if (!contact || typeof contact !== 'object') return { role: 'other', label: 'Contact', group: 'other', lenses: [], reason: '' };
  const hit = cache.get(contact);
  if (hit) return hit;
  const title = String(contact.position || '');
  const company = String(contact.company || '');
  const tags = Array.isArray(contact.tags) ? contact.tags.join(' ') : '';
  let out = null;
  for (const role of ROLES) {
    const byTitle = role.title && (role.title.test(title) || (tags && role.title.test(tags)));
    const byCompany = role.company && role.company.test(company);
    if (!byTitle && !byCompany) continue;
    // Generic titles ("Partner", "Associate") only count as investor when
    // the employer looks like a fund; otherwise fall through to later roles.
    if (byTitle && !byCompany && role.requireCompanyIf && role.requireCompanyIf.test(title) && !/\b(investor|investing|venture|vc|angel|private equity|growth equity|seed|general partner|operating partner)\b/i.test(title)) continue;
    const reason = byTitle && byCompany ? `Title and company: ${role.label.toLowerCase()}`
      : byTitle ? `Title: "${title.slice(0, 60)}"` : `Company: ${company.slice(0, 60)}`;
    out = { role: role.key, label: role.label, group: GROUP_KEY[role.group], lenses: [...role.lenses], reason };
    break;
  }
  // Anyone with a title or an employer works somewhere: they are placed
  // with the operators rather than left unplaced. Only a contact with
  // neither stays in "Everyone else".
  if (!out && (title.trim() || company.trim())) {
    out = { role: 'professional', label: title.trim() ? 'Professional' : 'Team member', group: 'founders', lenses: ['diligence'], reason: title.trim() ? `Title: "${title.slice(0, 60)}"` : `Company: ${company.slice(0, 60)}` };
  }
  if (!out) out = { role: 'other', label: 'No title', group: 'other', lenses: [], reason: '' };
  cache.set(contact, out);
  return out;
}

/** True when the contact belongs in the lens ('raise' | 'source' | 'diligence'). */
export function inLens(contact, lens) {
  return classifyContact(contact).lenses.includes(lens);
}

/** Counts per role and per lens for a list of contacts. */
export function roleStats(contacts) {
  const roles = {};
  const lenses = { raise: 0, source: 0, diligence: 0 };
  const groups = { investors: 0, founders: 0, experts: 0, other: 0 };
  for (const c of contacts || []) {
    const k = classifyContact(c);
    roles[k.role] = (roles[k.role] || 0) + 1;
    groups[k.group] = (groups[k.group] || 0) + 1;
    for (const l of k.lenses) lenses[l] += 1;
  }
  return { roles, lenses, groups };
}

/** Question phrasing that selects a lens, for "Ask your network". */
export const LENS_PATTERNS = [
  { lens: 'raise', re: /\b(raise|raising|fund-?rais\w*|lps?\b|limited partners?|allocators?|family offices?|endowments?|capital for (?:the|our|my) fund|commit(?:ments?)? to (?:the|our|my) fund|who (?:can|could|would) (?:invest|fund|back)|co-?invest\w*)\b/i },
  { lens: 'source', re: /\b(deal ?flow|source (?:deals?|companies|startups)|sourc\w* (?:deals?|startups?)|deal sourcing|find (?:deals|startups|founders)|founders? (?:to|i should) (?:meet|back)|see deals|proprietary deals|send me deals|origination)\b/i },
  { lens: 'diligence', re: /\b(diligence|due diligence|vet|vetting|reference(?: check)?s?|back-?channel|expert(?:s| call| network)?|evaluate|assess|validate|sanity[- ]check|who knows (?:about|the) (?:space|market|sector))\b/i },
];

export function lensFromQuestion(question) {
  const q = String(question || '');
  for (const p of LENS_PATTERNS) if (p.re.test(q)) return p.lens;
  return null;
}
