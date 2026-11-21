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
 * (ask your network) and in the browser (the map). Tags are never read as
 * titles: a CRM tag "partner" is a pipeline state, not a job.
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
    // Pension plans, endowments and their investment offices allocate to funds:
    // the people there are LPs whatever their title says.
    company: /\b(family office|endowment|pension|foundation|fund of funds|sovereign|wealth|private bank|asset management|capital management|investment management|investments? office|trust company|insurance|retirement system|superannuation|calpers|calstrs|cppib|cpp investments|temasek|gic|norges|harvard management company|teachers'? retirement)\b/i,
  },
  {
    key: 'investor', label: 'Investor', group: 'Investors & LPs', lenses: ['raise', 'source'],
    title: /\b(general partner|managing partner|venture partner|operating partner|partner|principal|associate|analyst|investor|investing|investment|venture|vc\b|angel|scout|fund|seed|growth equity|private equity|pe\b)\b/i,
    company: /\b(capital|ventures?|partners|vc\b|fund|angels?|seed|equity|investments?|holdings|accelerator|incubator|y combinator|techstars|500 ?(global|startups)|sequoia|andreessen|a16z|accel|benchmark|greylock|kleiner|lightspeed|khosla|bessemer|nea|founders fund|general catalyst|insight partners|tiger global|coatue|softbank|first round|redpoint|ivp|gv)\b/i,
    requireCompanyIf: /\b(partner|principal|associate|analyst|fund|investment)\b/i,
    unless: /\b(investor|investing|venture|vc|angel|private equity|growth equity|seed|general partner|operating partner)\b/i,
  },
  {
    key: 'accelerator', label: 'Accelerator / platform', group: 'Founders & executives', lenses: ['source'],
    title: /\b(accelerator|incubator|program (director|manager)|community|platform|ecosystem|startup program)\b/i,
    company: /\b(y combinator|techstars|500 ?(global|startups)|accelerator|incubator|founders? (institute|network)|launchpad|skydeck|alchemist|entrepreneur first|antler)\b/i,
    // "Program Manager" at a hospital or "Platform Engineer" is not accelerator staff:
    // these words count only at an accelerator.
    requireCompanyIf: /\b(program (director|manager)|community|platform|ecosystem)\b/i,
    unless: /\b(accelerator|incubator|startup program)\b/i,
  },
  {
    key: 'founder', label: 'Founder', group: 'Founders & executives', lenses: ['source', 'diligence'],
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
    // Before "consultant": a Policy Advisor works in policy, not in consulting.
    key: 'public', label: 'Public sector / policy', group: 'Experts & advisors', lenses: ['diligence'],
    title: /\b(policy|public affairs|government|public sector|diplomat|ambassador|senator|congress\w*|minister|regulat\w*|civil servant|military|veteran)\b/i,
    company: /\b(government|department of|ministry|federal|city of|state of|county of|u\.?s\.? (army|navy|air force|marine)|european commission|united nations|world bank|imf|oecd|nato)\b/i,
  },
  {
    key: 'consultant', label: 'Consultant / advisor', group: 'Experts & advisors', lenses: ['diligence'],
    title: /\b(consultant|consulting|advisor|adviser|advisory|strategist|board member|board director|independent director)\b/i,
    company: /\b(mckinsey|bain|bcg|boston consulting|accenture|deloitte|oliver wyman|kearney|strategy&|consulting|advisory)\b/i,
  },
  {
    // Before "academic": an MBA candidate at a university is a student, not a professor.
    key: 'student', label: 'Student / early career', group: 'Operators & talent', lenses: ['source'],
    title: /\b(student|mba candidate|mba student|ph\.?d\.? (candidate|student)|doctoral (candidate|student)|undergraduate|graduate student|intern|internship|trainee|apprentice|class of \d{2,4})\b/i,
  },
  {
    key: 'clinician', label: 'Clinician', group: 'Experts & advisors', lenses: ['diligence'],
    title: /\b(physician|doctor|surgeon|surgery|nurse|nurse practitioner|dentist|pharmacist|therapist|psychologist|psychiatrist|clinician|medical director|chief medical officer|internist|hospitalist|pediatrician|paediatrician|obstetrician|gyn[a]?ecologist|anesthesiologist|anaesthetist|\w*(cardio|onco|radio|neuro|dermato|gastroentero|endocrino|nephro|uro|ophthalmo|pulmono|hemato|haemato|rheumato|immuno|patho)logist|optometrist|midwife|paramedic|medical resident)\b/i,
    company: /\b(hospital|clinic|medical center|health system)\b/i,
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
    key: 'executive', label: 'Executive', group: 'Founders & executives', lenses: ['source', 'diligence'],
    title: /\b(cto|coo|cmo|cpo|cro|ciso|chief|c-level|vp|vice president|svp|evp|head of|general manager|gm\b|managing director|director)\b/i,
  },
  {
    key: 'operator', label: 'Operator', group: 'Operators & talent', lenses: ['diligence', 'source'],
    title: /\b(engineer\w*|develop\w*|programmer|architect|product|design\w*|ux|ui|data|scientist|market\w*|growth|sales|account\w*|customer|success|support|operations|ops|program|project|manag\w*|lead|leader|staff|senior|junior|principal|analyst|specialist|associate|assistant|coordinator|administrator|admin|officer|representative|recruit\w*|talent|people|hr|human resources|finance|strategy|partnerships?|business development|bd|researcher|technician|technical|supervisor|executive|head|producer|creative|content|brand|communications|procurement|supply chain|logistics|quality|qa|it|member of technical staff|mts)\b/i,
  },
];

// Order of the first layer of the map. The hints are plain and neutral: the
// map replaces them with a line built from the people inside each group.
export const ROLE_GROUPS = [
  { key: 'investors', label: 'Investors & LPs', hint: 'From job titles and employers', lens: 'raise' },
  { key: 'founders', label: 'Founders & executives', hint: 'From job titles', lens: 'source' },
  { key: 'operators', label: 'Operators & talent', hint: 'From job titles', lens: null },
  { key: 'other', label: 'Everyone else', hint: 'No title and no company in the import', lens: null },
  { key: 'experts', label: 'Experts & advisors', hint: 'From job titles and employers', lens: 'diligence' },
];
const GROUP_KEY = { 'Investors & LPs': 'investors', 'Founders & executives': 'founders', 'Operators & talent': 'operators', 'Experts & advisors': 'experts' };

/**
 * Families: the plain-words kinds of people the read-out and the shortcuts
 * count ("109 investors", "79 clinicians"). Investors and allocators are one
 * family. The broad roles (executive, operator, professional) are split by
 * what the title says; what is left of them is a catch-all that is never
 * shown on its own.
 */
export const FAMILIES = [
  { key: 'investors', one: 'investor', many: 'investors' },
  { key: 'founders', one: 'founder or CEO', many: 'founders and CEOs' },
  { key: 'engineers', one: 'engineer', many: 'engineers' },
  { key: 'product', one: 'product or design person', many: 'product and design people' },
  { key: 'data', one: 'data scientist or analyst', many: 'data and analytics people' },
  { key: 'sales', one: 'sales or marketing person', many: 'sales and marketing people' },
  { key: 'operations', one: 'operations person', many: 'operations people' },
  { key: 'finance', one: 'finance or accounting person', many: 'finance and accounting people' },
  { key: 'people', one: 'recruiter or HR person', many: 'recruiting and HR people' },
  { key: 'clinicians', one: 'clinician', many: 'clinicians' },
  { key: 'academics', one: 'researcher or academic', many: 'researchers and academics' },
  { key: 'bankers', one: 'banker', many: 'bankers' },
  { key: 'lawyers', one: 'lawyer', many: 'lawyers' },
  { key: 'consultants', one: 'consultant or advisor', many: 'consultants and advisors' },
  { key: 'partners', one: 'partner at a professional firm', many: 'partners at professional firms' },
  { key: 'accelerators', one: 'accelerator or community lead', many: 'accelerator and community leads' },
  { key: 'public', one: 'public sector person', many: 'public sector people' },
  { key: 'press', one: 'journalist or analyst', many: 'journalists and analysts' },
  { key: 'students', one: 'student', many: 'students and early-career people' },
  { key: 'leaders', one: 'other senior leader', many: 'other senior leaders', catchAll: true },
  { key: 'others', one: 'other professional', many: 'other professionals', catchAll: true },
  { key: 'unknown', one: 'person with no title', many: 'people with no title', catchAll: true },
];
const FAMILY_BY_KEY = new Map(FAMILIES.map((f) => [f.key, f]));
const ROLE_FAMILY = {
  lp: 'investors', investor: 'investors', accelerator: 'accelerators', founder: 'founders', banker: 'bankers', lawyer: 'lawyers',
  accountant: 'finance', public: 'public', consultant: 'consultants', student: 'students', clinician: 'clinicians', academic: 'academics',
  press: 'press', partner: 'partners', other: 'unknown',
};
// How the broad roles split by title, first match wins. Sales before product
// ("Product Marketing Manager" sells), product before engineering ("UX
// Researcher" designs), data work after engineering ("Data Engineer"
// builds), other science with the researchers.
const TITLE_FAMILY = [
  ['people', /\b(recruit\w*|talent|people (ops|operations|partner)|hr|human resources|hrbp)\b/i],
  ['finance', /\b(finance|financial|accounting|accountant|controller|cfo|fp&a|treasur\w*|risk)\b/i],
  ['sales', /\b(sales|account executive|account manag\w*|business development|bd|bdr|sdr|marketing|marketer|growth|partnerships?|customer success|revenue|brand|communications|pr|cmo|cro|go-to-market|gtm|demand gen\w*|merchandis\w*|e-?commerce)\b/i],
  ['product', /\b(product|design\w*|ux|ui|cpo|creative|art director|producer|content)\b/i],
  ['engineers', /\b(engineer\w*|develop\w*|programmer|software|architect|devops|sre|machine learning|ml|cto|technical|technology|it|qa|member of technical staff|mts|ciso|security)\b/i],
  // A data scientist is not an engineer; a data engineer is (matched above).
  ['data', /\b(data|analytics|business intelligence|bi|statistician|quant\w*)\b/i],
  ['academics', /\b(scien\w*|research\w*|cso)\b/i],
  ['operations', /\b(operations|ops|coo|chief of staff|supply chain|logistics|procurement|buyer|purchasing|program|project|administrator|admin|office manager|facilities|support|quality|store|trial)\b/i],
];

// Titles about money stay with an allocator or a fund whatever else they say.
const MONEY_WORDS = /\b(invest\w*|portfolio|fund|allocat\w*|private (equity|markets)|venture)\b/i;
const CATCH_ALL = new Set(['leaders', 'others', 'unknown']);

const cache = new WeakMap();

/** First role whose title (and, when used, company) matches. Tags are never read as titles. */
function matchRole(title, company, useCompany) {
  for (let i = 0; i < ROLES.length; i += 1) {
    const role = ROLES[i];
    const byTitle = !!(role.title && role.title.test(title));
    const byCompany = !!(useCompany && role.company && company && role.company.test(company));
    if (!byTitle && !byCompany) continue;
    // Generic titles ("Partner", "Associate", "Program Manager") only count
    // when the employer fits the role; otherwise fall through to later roles.
    if (byTitle && !byCompany && role.requireCompanyIf && role.requireCompanyIf.test(title) && !(role.unless && role.unless.test(title))) continue;
    return { role, index: i, byTitle, byCompany };
  }
  return null;
}

/** The role given by the title alone, ignoring the employer. */
const titleRole = (title) => matchRole(title, '', false);

/** Family key for a role, splitting the broad roles by the words in the title. */
function familyFor(roleKey, title) {
  if (ROLE_FAMILY[roleKey]) return ROLE_FAMILY[roleKey];
  for (const [key, re] of TITLE_FAMILY) if (re.test(title)) return key;
  return roleKey === 'executive' ? 'leaders' : 'others';
}

/**
 * Classify one contact. Returns { role, label, group, lenses: string[], reason, family }.
 * The result is cached per contact object.
 */
export function classifyContact(contact) {
  if (!contact || typeof contact !== 'object') return { role: 'other', label: 'Contact', group: 'other', lenses: [], reason: '', family: 'unknown' };
  const hit = cache.get(contact);
  if (hit) return hit;
  const title = String(contact.position || '');
  const company = String(contact.company || '');
  let m = matchRole(title, company, true);
  if (m && m.byCompany && !m.byTitle) {
    // The employer's name alone gave the role. A later role that both the
    // title and the employer fit says more ("Program Director" at Y
    // Combinator is accelerator staff, not an investor).
    // A role of the same family adds nothing ("Investment Officer" at an
    // endowment stays an allocator).
    const own = ROLE_FAMILY[m.role.key];
    for (let j = m.index + 1; j < ROLES.length; j += 1) {
      const r = ROLES[j];
      if (ROLE_FAMILY[r.key] === own) continue;
      if (r.title && r.company && r.title.test(title) && r.company.test(company)) { m = { role: r, index: j, byTitle: true, byCompany: true }; break; }
    }
  }
  let titleWins = false;
  if (m && m.byCompany && !m.byTitle && title.trim() && !MONEY_WORDS.test(title)) {
    // Otherwise a title that names a different kind of job wins: an engineer
    // at "Cobalt Capital" is an engineer, a product manager or a buyer at a
    // hospital is not a clinician. A title that says nothing more specific
    // ("Managing Director", "Partner", "Engagement Manager") keeps the
    // employer's role.
    const t = titleRole(title);
    const tFamily = familyFor(t ? t.role.key : 'professional', title);
    if (tFamily !== ROLE_FAMILY[m.role.key] && !CATCH_ALL.has(tFamily) && !(t && t.role.key === 'partner')) {
      m = t;
      titleWins = true;
    }
  }
  let out = null;
  if (m) {
    const { role, byTitle, byCompany } = m;
    const reason = byTitle && byCompany ? `Title and company: ${role.label.toLowerCase()}`
      : byTitle ? `Title: "${title.slice(0, 60)}"` : `Company: ${company.slice(0, 60)}`;
    out = { role: role.key, label: role.label, group: GROUP_KEY[role.group], lenses: [...role.lenses], reason, family: familyFor(role.key, title) };
  }
  // Anyone with a title or an employer works somewhere: they are placed
  // with the operators rather than left unplaced. Only a contact with
  // neither stays in "Everyone else".
  if (!out && (title.trim() || company.trim())) {
    out = { role: 'professional', label: title.trim() ? 'Professional' : 'Team member', group: 'operators', lenses: ['diligence'], reason: title.trim() || titleWins ? `Title: "${title.slice(0, 60)}"` : `Company: ${company.slice(0, 60)}`, family: familyFor('professional', title) };
  }
  if (!out) out = { role: 'other', label: 'No title', group: 'other', lenses: [], reason: '', family: 'unknown' };
  cache.set(contact, out);
  return out;
}

/** The contact's family: { key, one, many } ("investor" / "investors"). */
export function familyOf(contact) {
  return FAMILY_BY_KEY.get(classifyContact(contact).family) || FAMILY_BY_KEY.get('others');
}

/** A family by key, or null. */
export const familyByKey = (key) => FAMILY_BY_KEY.get(key) || null;

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
