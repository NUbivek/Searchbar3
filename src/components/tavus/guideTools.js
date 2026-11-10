/**
 * The guide agent's view of the site and the actions it can take, kept free
 * of React and of the widget so it can be unit-tested.
 *
 * Tools (define the same names and parameters on the PAL in the Tavus PAL
 * Maker; see docs/tavus/03-pal-tools.md):
 *   go_to_section       { section: "open_research" | "network_map" | "founder_check" }
 *   run_research        { query: string }
 *   run_founder_check   { name: string, company?: string }
 */

export const SECTIONS = {
  open_research: { path: '/', label: 'Open Research' },
  network_map: { path: '/network', label: 'Network Map' },
  founder_check: { path: '/founder', label: 'Founder Check' },
};

const PAGE_LABELS = {
  '/': 'Open Research (research a company, founder or market)',
  '/network': 'Network Map (the visitor\'s own contacts on a globe, with a dashboard beside it, an ask bar above it, and "Zoom to" and "Presets" bars below it)',
  '/founder': 'Founder Check (background brief on one person)',
  '/workspaces': 'Workspaces (deal workspaces)',
  '/workspaces/[id]': 'a deal workspace',
  '/workspaces/[id]/memo': 'a deal memo',
  '/watchlist': 'Watchlist (watched companies and alerts)',
  '/history': 'History (saved searches)',
  '/history/[id]': 'a saved search',
  '/company/[name]': 'a company profile',
  '/signin': 'Sign in',
  '/privacy': 'Privacy policy',
  '/terms': 'Terms of service',
};

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * One line telling the agent where the visitor is and what they are looking
 * at, from the route and its query (the pages keep their current query in
 * the URL).
 */
export function describePage(pathname, query = {}) {
  const page = PAGE_LABELS[pathname] || pathname || 'the site';
  const parts = [`The visitor is on ${page}.`];
  if (pathname === '/' && str(query.q)) parts.push(`Their current research query is "${str(query.q)}".`);
  if (pathname === '/founder' && str(query.name)) {
    parts.push(`They are checking the founder "${str(query.name)}"${str(query.company) ? ` at ${str(query.company)}` : ''}.`);
  }
  if (pathname === '/company/[name]' && str(query.name)) parts.push(`The company is "${str(query.name)}".`);
  return parts.join(' ');
}

/**
 * Context given to the agent when a conversation starts. It carries the
 * routing rules as well as the page, so the agent can act on the first
 * request without searching its knowledge documents.
 */
export function initialContext(pathname, query) {
  return [
    'You are the video guide for Research Hub, a due-diligence site for venture investors with three sections:',
    'Open Research (cited research on any company, founder or market), Network Map (the visitor\'s own contacts,',
    'grouped by who can help them raise capital, source deals or diligence), and Founder Check (a background brief on one person).',
    'Use the tools at once, without asking first:',
    'run_research when they name a company, market or topic (query: name first, then what they want, 3 to 10 words);',
    'run_founder_check when they name a person (first and last name, plus the company if mentioned);',
    'go_to_section for a section, and network_map for anything about their own contacts.',
    'You cannot click inside a page or see results: after a tool runs, say in one sentence where to look.',
    describePage(pathname, query),
  ].join(' ');
}

/**
 * Turn a tool call into a route to push, or an error. Never throws.
 * @returns {{ href?: { pathname: string, query?: object }, say?: string, error?: string }}
 */
export function planToolCall(name, rawArguments) {
  let args = {};
  try {
    args = rawArguments ? JSON.parse(rawArguments) : {};
    if (!args || typeof args !== 'object') args = {};
  } catch {
    return { error: 'The tool arguments were not valid JSON.' };
  }
  if (name === 'go_to_section') {
    const section = SECTIONS[str(args.section)];
    if (!section) return { error: `Unknown section "${str(args.section)}". Use open_research, network_map or founder_check.` };
    return { href: { pathname: section.path }, say: `Opened ${section.label}.` };
  }
  if (name === 'run_research') {
    const query = str(args.query).slice(0, 300);
    if (!query) return { error: 'A research query is required.' };
    return { href: { pathname: '/', query: { q: query } }, say: `Running research for "${query}" on Open Research. Results appear on the page in a few seconds.` };
  }
  if (name === 'run_founder_check') {
    const fullName = str(args.name).slice(0, 120);
    const company = str(args.company).slice(0, 120);
    if (!fullName) return { error: 'The founder\'s full name is required.' };
    if (fullName.split(/\s+/).length < 2) return { error: 'Founder Check needs a first and last name.' };
    return {
      href: { pathname: '/founder', query: company ? { name: fullName, company } : { name: fullName } },
      say: `Running a founder check on ${fullName}${company ? ` (${company})` : ''}. The brief appears on the page shortly.`,
    };
  }
  return { error: `Unknown tool "${name}".` };
}
