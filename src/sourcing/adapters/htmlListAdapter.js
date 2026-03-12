const cheerio = require('cheerio');
const { BaseAdapter } = require('./baseAdapter');

const BLOCKED_LABEL_PATTERNS = [
  /^(about|contact|team|jobs|careers|news|blog|events|event|resources|portfolio|companies|company|founders|investors|advisors|mentors|speakers|exhibitors|agenda|program|programs|schedule|register|registration|apply|learn more|read more|view all|load more|watch now|submit|follow|privacy|terms|support|home|menu|faq|startups|startup|initiatives)$/i,
  /\b(cookie|policy|press release|newsletter|podcast|episode|directory|community|sponsor|sponsors|sponsorship|book a demo)\b/i,
  /\b(submit|apply|join|follow|register|registration)\b/i,
  /\b(login|log in|portal|investor portal|lp login|club portal)\b/i,
];

const COMPANY_HINT_PATTERNS = [
  /\b(ai|bio|robot|robotics|labs|systems|software|tech|technologies|logistics|supply|manufacturing|industrial|data|cloud|commerce|payments|energy|health|ag|agri|farm|freight|mobility)\b/i,
  /[A-Z].*[A-Z]/,
];

const TEASER_LABEL_PATTERNS = [
  /\bread story\b/i,
  /\b(learn more|view case study|see more|discover more)\b/i,
  /\b(transforming|solving|supercharging|enabling|modernizing|improving|reinventing|reimagining|building|connecting|unlocking|securing)\b/i,
  /\b(the future of|everything you need to|easy [a-z]+|foundational technology)\b/i,
];

const NON_STARTUP_NAME_PATTERN = /^(etsy|amazon|google|apple|microsoft|meta|netflix|uber|airbnb|shopify|stripe|paypal|ebay|walmart|target|costco|indeed|glassdoor|linkedin|twitter|facebook|instagram|tiktok|youtube|huffington post|huffpost|forbes|techcrunch|reuters|bloomberg|uluru statement|etsy registry|our accelerators|view all companies|meet our portfolio|our portfolio|our companies|our investments|featured companies|all companies|all startups)$/i;
const HEADLINE_VERB_PATTERN = /\b(launches|launch|raises|raise|acquires|acquire|announces|announce|partners with|joins|join|wins|win|selected|named|awarded|brings|readies|sets stage)\b/i;
const UI_PATTERNS = /^(load more|see more|view all|show more|read more|learn more|find out more|explore|discover|apply now|get started|sign up|log in|login|sign in|register|subscribe|contact us|about us|our team|meet the team|news insights|job board|careers|open roles|newsletter|follow us|share|privacy policy|terms|cookie|copyright|all rights reserved|back to top|scroll|menu|navigation|footer|header|sidebar)$/i;
const GENERIC_PHRASES = /^(general funding|impact|growth|innovation|solutions|technologies|ventures|capital|partners|insights|report|update|announcement|press release|blog post|case study|white paper|webinar|event|conference|summit|demo day|pitch deck|filters here|supply chain integrations|world positive report|open lp|substack)$/i;
const SOCIAL_PLATFORM_PATTERN = /^(twitter|x\.com|linkedin|facebook|instagram|youtube|tiktok|reddit|github|substack|medium|notion|slack|zoom|discord|telegram|whatsapp)(\s+(icon|logo|link|page|profile|handle))?$/i;
const EMAIL_FRAGMENT_PATTERN = /^(info|admin|contact|hello|team|support|noreply|careers)([._-]?[a-z0-9_-]{3,})?$/i;
const DOMAIN_FRAGMENT_PATTERN = /^(info|admin|contact|hello|newsletter|careers|jobs|blog|news|press|about|team|investor|media)[a-z]*$/i;

const DETAIL_PATH_PATTERNS = [
  /\/(companies|company|portfolio|startups|residents|founders|alumni|ventures|exhibitors|speakers)\//i,
  /\/(companies|company|portfolio|startups|residents|founders|alumni|ventures|exhibitors|speakers)$/i,
];

const BLOCKED_HOST_PATTERNS = [
  /linkedin\.com$/i,
  /x\.com$/i,
  /twitter\.com$/i,
  /facebook\.com$/i,
  /instagram\.com$/i,
  /tiktok\.com$/i,
  /youtube\.com$/i,
  /youtu\.be$/i,
  /medium\.com$/i,
  /substack\.com$/i,
  /news\.ycombinator\.com$/i,
  /crunchbase\.com$/i,
  /brandfolder\.com$/i,
  /g2\.com$/i,
  /^help\./i,
  /^share\./i,
  /^forms\./i,
];

const STARTUP_DIRECTORY_CATEGORIES = new Set([
  'venture_portfolio',
  'accelerator_portfolio',
  'startup_database',
  'university_accelerator',
  'accelerator_directory',
]);

const SOURCE_BRAND_STOPWORDS = new Set([
  'ventures',
  'venture',
  'capital',
  'labs',
  'lab',
  'partners',
  'partner',
  'strategic',
  'accelerator',
  'fund',
  'group',
  'innovation',
  'collective',
]);

const PROFILE_CONFIG = {
  html_list: {
    itemSelectors: [
      '[data-select="item"]',
      '.tcs-item',
      '.ash-item',
      '.ptp-panel',
      '[data-feed-item] [data-company], [data-feed-item]',
      '.company-items',
      '.portfolio_item',
      '.portfolio-item',
      '.company-card',
      '.listing-card',
      '.w-dyn-item',
      '[role="listitem"]',
      'article',
      'li',
      'a[href]',
    ],
    titleSelectors: [
      '[data-select="name"]',
      '[fs-list-field="name"]',
      '.tcs-item-title h2',
      '.ash-item-cnt-title h3, .ash-item-cnt-title h2, .ash-item-cnt-title a',
      '.ptp-panel-cnt h2',
      '.portfolio-item_logo',
      '[class*="company-name"]',
      '[class*="company_name"]',
      '[class*="portfolio-title"]',
      '[class*="card-title"]',
      '[class*="item-title"]',
      '[class*="headline"]',
      '[class*="title"]',
      '[class*="name"]',
      'h1',
      'h2',
      'h3',
      'h4',
      'img[alt]',
      'strong',
      'b',
      'a[href]',
    ],
    linkSelectors: [
      '.portfolio_link[href]',
      '.tcs-item-link a[href]',
      '.ash-item-cnt-title a[href]',
      '.ptp-panel-cnt a[href]',
      'a[href]',
    ],
    contentSelectors: [
      '[fs-list-field="investment"]',
      '[fs-list-field="sector"]',
      '[fs-list-field="status"]',
      '.portfolio-item_text-wrapper .text-size-tiny',
      '.tcs-item-desc p',
      '.ash-item-ctn-info p, .ash-item-cnt p',
      '.ptp-panel-cnt p',
      '[class*="description"]',
      '[class*="summary"]',
      '[class*="excerpt"]',
      '[class*="text"]',
      '[class*="eyebrow"]',
      'p',
    ],
    limit: 400,
  },
  exhibitor_list: {
    itemSelectors: [
      '[class*="exhibitor"]',
      '[id*="exhibitor"]',
      '[data-exhibitor]',
      '[class*="sponsor"]',
      '[class*="vendor"]',
      '.company-card',
      '.listing-card',
    ],
    titleSelectors: [
      '[class*="company"]',
      '[class*="name"]',
      'h1',
      'h2',
      'h3',
      'h4',
      'a[href]',
    ],
    linkSelectors: [
      'a[href]',
    ],
    contentSelectors: [
      '[class*="description"]',
      '[class*="summary"]',
      '[class*="tag"]',
      '[class*="category"]',
      'p',
    ],
    limit: 400,
  },
  speaker_list: {
    itemSelectors: [
      '[class*="speaker"]',
      '[id*="speaker"]',
      '[data-speaker]',
      '.speaker-card',
      '.team-card',
      '.profile-card',
    ],
    titleSelectors: [
      '[class*="company"]',
      '[class*="organization"]',
      '[class*="org"]',
      '[class*="employer"]',
      '[class*="affiliation"]',
      '[class*="name"]',
      'h1',
      'h2',
      'h3',
      'h4',
    ],
    linkSelectors: [
      'a[href]',
    ],
    contentSelectors: [
      '[class*="company"]',
      '[class*="organization"]',
      '[class*="title"]',
      '[class*="role"]',
      'p',
    ],
    limit: 180,
  },
  attendee_search: {
    itemSelectors: [
      '[class*="attendee"]',
      '[id*="attendee"]',
      '[data-attendee]',
      '.company-card',
      '.listing-card',
    ],
    titleSelectors: [
      '[class*="company"]',
      '[class*="name"]',
      'h1',
      'h2',
      'h3',
      'h4',
      'a[href]',
    ],
    linkSelectors: [
      'a[href]',
    ],
    contentSelectors: [
      '[class*="description"]',
      '[class*="summary"]',
      '[class*="tag"]',
      'p',
    ],
    limit: 400,
  },
};

function toSelectorList(value, fallback) {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }

  if (typeof value === 'string' && value.trim()) {
    return [value];
  }

  return fallback ? [fallback] : [];
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function firstMatchingNode($, rootNode, selectors, fallbackNode) {
  for (const selector of selectors) {
    const match = rootNode.find(selector).first();

    if (match.length > 0) {
      return match;
    }
  }

  return fallbackNode || null;
}

function readNodeValue(node, attributeName) {
  if (!node || node.length === 0) {
    return '';
  }

  if (attributeName) {
    return (node.attr(attributeName) || '').replace(/\s+/g, ' ').trim();
  }

  return node.text().replace(/\s+/g, ' ').trim();
}

function readMergedValues($, rootNode, selectors, attributeName, joinWith) {
  if (!selectors.length) {
    return '';
  }

  const values = [];
  const seen = new Set();

  for (const selector of selectors) {
    rootNode.find(selector).each((_, element) => {
      const node = $(element);
      const value = readNodeValue(node, attributeName);

      if (!value || seen.has(value)) {
        return;
      }

      seen.add(value);
      values.push(value);
    });
  }

  return values.join(joinWith);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function getHost(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function getRootDomain(value = '') {
  const host = String(value || '').includes('://')
    ? getHost(value)
    : String(value || '').toLowerCase().replace(/^www\./, '');
  if (!host) {
    return '';
  }

  const parts = host.split('.');
  if (parts.length <= 2) {
    return host;
  }

  return parts.slice(-2).join('.');
}

function normalizeCompanyLabel(value) {
  return cleanText(value)
    .replace(/\b(inc|inc\.|llc|ltd|corp|corporation|company)\b/gi, '')
    .replace(/[^\w\s&.+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCandidateLabel(value) {
  return normalizeCompanyLabel(
    String(value || '')
      .replace(/([A-Za-z0-9])(Read story)\b/g, '$1 $2')
      .replace(/([A-Za-z0-9])(Learn more)\b/g, '$1 $2')
      .replace(/PortalPlus/g, 'Portal Plus')
      .replace(/\bRead story\b/gi, ' ')
      .replace(/\bLearn more\b/gi, ' ')
  );
}

function isBlockedLabel(value) {
  const text = cleanText(value);
  if (!text || text.length < 2 || text.length > 80) {
    return true;
  }

  if (BLOCKED_LABEL_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }

  if (/[{}<>]/.test(text)) {
    return true;
  }

  if (text.split(/\s+/).length > 6) {
    return true;
  }

  return false;
}

function looksLikeTeaserLabel(value) {
  const text = cleanText(value);
  if (!text) {
    return true;
  }

  if (TEASER_LABEL_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }

  if (/[,:;!?]/.test(text)) {
    return true;
  }

  if (text.split(/\s+/).length > 6) {
    return true;
  }

  return false;
}

function stripVisitPrefix(value) {
  return String(value || '').replace(/^Visit\s+/i, '').trim();
}

function looksLikeCompanyLabel(value) {
  const text = normalizeCompanyLabel(stripVisitPrefix(value));
  if (isBlockedLabel(text)) {
    return false;
  }

  if (!text || text.length < 2 || text.length > 80) {
    return false;
  }

  if (text === text.toUpperCase() && text.length > 4) {
    return false;
  }

  if (/[—:\-–]\s*$/.test(text)) {
    return false;
  }

  if (NON_STARTUP_NAME_PATTERN.test(text.trim())) {
    return false;
  }

  if (!/[a-zA-Z]{3,}/.test(text)) {
    return false;
  }

  if (HEADLINE_VERB_PATTERN.test(text)) {
    return false;
  }

  if (/^\+?[\d\s\-().]{7,}$/.test(text)) {
    return false;
  }

  if (/^[a-z0-9._%+-]+@/i.test(text) || EMAIL_FRAGMENT_PATTERN.test(text.toLowerCase())) {
    return false;
  }

  if (/\b(icon|logo|image|img|svg|png|jpg|gif|banner|thumbnail|avatar|badge)\b/i.test(text)) {
    return false;
  }

  if (UI_PATTERNS.test(text.trim())) {
    return false;
  }

  if (GENERIC_PHRASES.test(text.trim())) {
    return false;
  }

  if (SOCIAL_PLATFORM_PATTERN.test(text.trim())) {
    return false;
  }

  if (/^[A-Z][A-Z\s]{4,}$/.test(text.trim()) && !/\b(AI|ML|B2B|IoT|API|SaaS|ERP|WMS|TMS)\b/.test(text)) {
    return false;
  }

  if (/^[a-z][a-z0-9]{2,}[a-z]$/.test(text) && text.length < 20 && !text.includes(' ') && DOMAIN_FRAGMENT_PATTERN.test(text)) {
    return false;
  }

  if (/^(campus|recent investments|university (library|news))$/i.test(text.trim())) {
    return false;
  }

  if (/\b(health center|medical center|student center|care center)\b/i.test(text)) {
    return false;
  }

  if (/\(acquired by|acquired by\s|merger with|merged with/i.test(text)) {
    return false;
  }


  if (/^[a-z0-9][a-z0-9 .&+-]*$/i.test(text) && text.length >= 3) {
    return true;
  }

  return COMPANY_HINT_PATTERNS.some((pattern) => pattern.test(text));
}

function isBlockedUrl(url, sourceHost) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!host) {
      return true;
    }

    if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
      return true;
    }

    const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
    if (/\/(tag|category|author|careers|jobs|team|about|privacy|terms|contact|press|news|blog|events?|login|portal|accounts?)\b/i.test(path)) {
      return true;
    }

    if (/\/article\//i.test(path)) {
      return true;
    }

    if (sourceHost && host === sourceHost && !DETAIL_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

function inferCompanyWebsiteFromLink(absoluteUrl, sourceHost) {
  if (absoluteUrl.startsWith('mailto:')) {
    return '';
  }

  const host = getHost(absoluteUrl);
  if (
    !host
    || host === sourceHost
    || getRootDomain(host) === getRootDomain(sourceHost)
    || BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(host))
  ) {
    return '';
  }

  return absoluteUrl;
}

function inferFallbackCompanyName($, node, fallbackText) {
  const candidates = [];
  const pushCandidate = (value) => {
    const text = normalizeCompanyLabel(stripVisitPrefix(value));
    if (!text || text === normalizeCompanyLabel(stripVisitPrefix(fallbackText))) {
      return;
    }

    if (!looksLikeCompanyLabel(text)) {
      return;
    }

    candidates.push(text);
  };

  const selectors = [
    '[class*="company"]',
    '[class*="name"]',
    '[class*="startup"]',
    '[class*="portfolio"] h1, [class*="portfolio"] h2, [class*="portfolio"] h3, [class*="portfolio"] h4',
    'h1',
    'h2',
    'h3',
    'h4',
    'strong',
    'b',
  ];

  const ancestors = [node, node.parent(), node.parent().parent(), node.parent().parent().parent()]
    .filter((entry, index, list) => entry && entry.length > 0 && list.findIndex((x) => x[0] === entry[0]) === index);

  const directParent = node.parent();
  if (directParent && directParent.length > 0) {
    directParent.find('.company-name, [class*="company"], [class*="name"], h1, h2, h3, h4, strong, b').each((_, element) => {
      pushCandidate($(element).text());
    });
  }

  node.siblings('h1, h2, h3, h4, [class*="company"], [class*="name"], strong, b').each((_, element) => {
    pushCandidate($(element).text());
  });

  for (const ancestor of ancestors) {
    for (const selector of selectors) {
      ancestor.find(selector).each((_, element) => {
        pushCandidate($(element).text());
      });
    }
  }

  candidates.sort((left, right) => left.length - right.length);
  return candidates[0] || normalizeCompanyLabel(fallbackText);
}

function titleFromUrlSlug(url = '') {
  try {
    const parsed = new URL(url);
    const parts = (parsed.pathname || '/').split('/').filter(Boolean);
    const slug = parts[parts.length - 1] || '';
    if (!slug) return '';
    return normalizeCompanyLabel(
      slug
        .replace(/[-_]+/g, ' ')
        .replace(/\b(public|companies|company)\b/gi, ' ')
    );
  } catch {
    return '';
  }
}

function titleFromCompanyWebsite(url = '') {
  try {
    const parsed = new URL(url);
    const hostLabel = (parsed.hostname || '')
      .toLowerCase()
      .replace(/^www\./, '')
      .split('.')
      .slice(0, -1)
      .join(' ');
    return normalizeCompanyLabel(hostLabel.replace(/[-_]+/g, ' '));
  } catch {
    return '';
  }
}

function preferredCompanyName(rawName, fallbackName, absoluteUrl) {
  const cleanedRaw = cleanCandidateLabel(stripVisitPrefix(rawName));
  const cleanedFallback = cleanCandidateLabel(stripVisitPrefix(fallbackName));
  const slugName = cleanCandidateLabel(titleFromUrlSlug(absoluteUrl));

  if (cleanedRaw && !looksLikeTeaserLabel(cleanedRaw) && looksLikeCompanyLabel(cleanedRaw)) {
    return cleanedRaw;
  }

  if (cleanedFallback && !looksLikeTeaserLabel(cleanedFallback) && looksLikeCompanyLabel(cleanedFallback)) {
    return cleanedFallback;
  }

  if (slugName && looksLikeCompanyLabel(slugName)) {
    return slugName;
  }

  return cleanedRaw || cleanedFallback || slugName;
}

function pickStrongCompanyName($, node, linkNode, titleNode, companyName, title, absoluteUrl) {
  const candidates = [
    node.find('[fs-list-field="name"]').first().text(),
    node.find('.portfolio-item_logo').first().attr('alt'),
    node.find('img[alt]').first().attr('alt'),
    node.find('.tcs-item-title h2').first().text(),
    node.find('.ash-item-cnt-title h3, .ash-item-cnt-title h2, .ash-item-cnt-title a').first().text(),
    node.find('.ptp-panel-cnt h2').first().text(),
    linkNode && (linkNode.attr('aria-label') || ''),
    companyName,
    title,
    titleFromUrlSlug(absoluteUrl),
  ]
    .map((value) => cleanCandidateLabel(value))
    .filter(Boolean);

  for (const candidate of candidates) {
    if (!looksLikeTeaserLabel(candidate) && looksLikeCompanyLabel(candidate)) {
      return candidate;
    }
  }

  const preferred = preferredCompanyName(companyName || title, title, absoluteUrl);
  if (preferred) {
    return preferred;
  }

  return inferFallbackCompanyName($, node, companyName || title || titleFromUrlSlug(absoluteUrl));
}

function workbookProfile(source = {}) {
  const adapter = String(source.workbook_adapter || '').trim();
  if (adapter && PROFILE_CONFIG[adapter]) return PROFILE_CONFIG[adapter];

  const signalType = String(source.signal_type || '').trim();
  if (String(source.adapter || '').trim() === 'html_list') return PROFILE_CONFIG.html_list;
  if (signalType === 'cohort_page_scrape') return PROFILE_CONFIG.speaker_list;
  if (signalType === 'portfolio_page_scrape') return PROFILE_CONFIG.exhibitor_list;
  if (signalType === 'structured_db_query') return PROFILE_CONFIG.exhibitor_list;
  return null;
}

async function resolveDetailPageCompanyWebsite(adapter, detailUrl, sourceHost) {
  try {
    await adapter.ensureRobotsAllowed(detailUrl);
    const response = await fetch(detailUrl, {
      signal: AbortSignal.timeout(Math.min(adapter.timeoutMs || 10000, 3000)),
      headers: {
        'User-Agent': adapter.userAgent || 'Searchbar3-Sourcing/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    let winner = '';

    $('a[href]').each((_, element) => {
      if (winner) {
        return false;
      }

      const href = $(element).attr('href') || '';
      if (!href || href.startsWith('mailto:')) {
        return;
      }

      const absolute = new URL(href, detailUrl).toString();
      if (isBlockedUrl(absolute, sourceHost)) {
        return;
      }

      const externalWebsite = inferCompanyWebsiteFromLink(absolute, sourceHost);
      if (!externalWebsite) {
        return;
      }

      winner = externalWebsite;
      return false;
    });

    return winner;
  } catch {
    return '';
  }
}

function looksLikeInventorySource(source = {}) {
  return STARTUP_DIRECTORY_CATEGORIES.has(String(source.category || '').toLowerCase());
}

function sourceBrandTokens(source = {}) {
  return normalizeCompanyLabel(source.name || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !SOURCE_BRAND_STOPWORDS.has(token));
}

function looksLikeSourceBrandSelfLink(source, label, companyWebsite) {
  const tokens = sourceBrandTokens(source);
  if (tokens.length === 0) {
    return false;
  }
  const haystack = `${normalizeCompanyLabel(label || '').toLowerCase()} ${getRootDomain(companyWebsite || '')}`.trim();
  return tokens.some((token) => haystack.includes(token));
}

function normalizeStructuredCompany(item, sourceUrl, sourceHost) {
  if (!item || typeof item !== 'object') return null;
  const startupUrl = cleanText(item.external_url || item.company_url || item.url || item.permalink || '');
  const detailUrl = cleanText(item.permalink || item.url || startupUrl || '');
  const absoluteDetailUrl = detailUrl ? new URL(detailUrl, sourceUrl).toString() : '';
  const title = stripVisitPrefix(preferredCompanyName(
    item.name || item.post_title || item.display_name || '',
    item.title || '',
    absoluteDetailUrl || startupUrl || sourceUrl
  ));
  if (!looksLikeCompanyLabel(title)) return null;
  const description = cleanText(item.website_description || item.oneliner || item.overview || item.description || '');
  const resolvedUrl = startupUrl || detailUrl;
  if (!resolvedUrl) return null;

  return {
    title,
    url: new URL(detailUrl || resolvedUrl, sourceUrl).toString(),
    content: description || title,
    company_name: title,
    company_website: startupUrl ? new URL(startupUrl, sourceUrl).toString() : inferCompanyWebsiteFromLink(new URL(resolvedUrl, sourceUrl).toString(), sourceHost) || undefined,
    publishedAt: new Date().toISOString(),
    confidence: 0.82,
    signal_type: 'directory_listing',
  };
}

function parseCompaniesDataAttributes($, sourceUrl, sourceHost, limit) {
  const results = [];
  const seen = new Set();
  const urlCategory = (() => {
    try {
      const value = new URL(sourceUrl).searchParams.get('category') || '';
      return value.trim().toLowerCase();
    } catch {
      return '';
    }
  })();

  $('[data-companies]').each((_, element) => {
    if (results.length >= limit) return false;
    const raw = $(element).attr('data-companies') || '';
    if (!raw) return;
    try {
      const parsed = JSON.parse(decodeHtmlEntities(raw));
      const companies = Array.isArray(parsed) ? parsed : [];
      for (const company of companies) {
        if (results.length >= limit) break;
        if (urlCategory) {
          const haystack = [
            ...(Array.isArray(company.tags) ? company.tags : []),
            cleanText(company.filter_by),
            cleanText(company.verticals),
            ...(Array.isArray(company.focus_areas) ? company.focus_areas : []),
          ].join(' ').toLowerCase();
          if (!haystack.includes(urlCategory.replace(/-/g, ' ')) && !haystack.includes(urlCategory)) {
            continue;
          }
        }
        const normalized = normalizeStructuredCompany(company, sourceUrl, sourceHost);
        if (!normalized || seen.has(normalized.url)) continue;
        seen.add(normalized.url);
        results.push(normalized);
      }
    } catch {
      // ignore malformed data-companies payloads
    }
  });

  return results;
}

function looksLikeCompanyArray(path, sampleItem) {
  const keys = Object.keys(sampleItem || {});
  const pathHint = /company|companies|portfolio|startup|startups|resident|residents|cohort|cohorts|venture|ventures/i.test(path);
  const keyHint = keys.some((key) => /company|external_link|company_url|website|permalink|internal_link|slug|detail|sector|founder|location/i.test(key));
  return pathHint || keyHint;
}

function findStructuredArrays(node, path = '$', matches = []) {
  if (Array.isArray(node)) {
    const qualifyingItems = node.filter((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const rawName = cleanText(item.name || item.title || item.company_name || item.text || '');
      const rawUrl = cleanText(
        item.url
        || item.website
        || item.href
        || item.external_url
        || item.external_link
        || item.company_url
        || ''
      );
      return rawName.length >= 3 && rawName.length <= 80 && (!!rawUrl || item.detail || item.internal_link);
    });
    if (qualifyingItems.length >= 5 && looksLikeCompanyArray(path, qualifyingItems[0])) {
      matches.push({ path, items: qualifyingItems });
    }
    for (let i = 0; i < node.length; i += 1) {
      findStructuredArrays(node[i], `${path}[${i}]`, matches);
    }
    return matches;
  }

  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      findStructuredArrays(value, `${path}.${key}`, matches);
    }
  }

  return matches;
}

function normalizeNextDataCompany(item, source, sourceUrl, sourceHost) {
  const rawUrl = cleanText(
    item?.external_link
    || item?.company_url
    || item?.website
    || item?.url
    || item?.href
    || item?.external_url
    || item?.detail?.external_link
    || item?.detail?.company_url
    || item?.detail?.website
    || item?.detail?.url
    || ''
  );
  if (!/^https?:\/\//i.test(rawUrl)) {
    return null;
  }

  const absoluteUrl = new URL(rawUrl, sourceUrl).toString();
  const companyWebsite = inferCompanyWebsiteFromLink(absoluteUrl, sourceHost);
  if (!companyWebsite) {
    return null;
  }

  const title = stripVisitPrefix(preferredCompanyName(
    item?.name || item?.company_name || item?.detail?.name || '',
    item?.title || item?.detail?.title || '',
    absoluteUrl
  ));
  if (!title || !looksLikeCompanyLabel(title)) {
    return null;
  }

  if (looksLikeSourceBrandSelfLink(source, title, companyWebsite)) {
    return null;
  }

  const description = cleanText(
    item?.description || item?.overview || item?.summary || item?.oneliner || item?.subtitle || ''
  );

  return {
    title,
    url: absoluteUrl,
    content: description || title,
    company_name: title,
    company_website: companyWebsite,
    publishedAt: new Date().toISOString(),
    confidence: 0.85,
    signal_type: 'directory_listing',
  };
}

function extractCompaniesFromNextData(data, source, sourceUrl, sourceHost, limit) {
  const arrays = findStructuredArrays(data);
  const results = [];
  const seenDomains = new Set();
  const seenUrls = new Set();

  for (const entry of arrays) {
    const companies = Array.isArray(entry?.items) ? entry.items : [];
    const arrayResults = [];
    const arrayDomains = new Set();
    for (const company of companies) {
      if (results.length >= limit) {
        return results;
      }

      const normalized = normalizeNextDataCompany(company, source, sourceUrl, sourceHost);
      if (!normalized) {
        continue;
      }

      const companyDomain = getRootDomain(normalized.company_website || '');
      if (!companyDomain || seenDomains.has(companyDomain) || seenUrls.has(normalized.url) || arrayDomains.has(companyDomain)) {
        continue;
      }

      arrayDomains.add(companyDomain);
      arrayResults.push(normalized);
    }

    if (arrayResults.length < 5) {
      continue;
    }

    for (const normalized of arrayResults) {
      if (results.length >= limit) {
        return results;
      }
      seenDomains.add(getRootDomain(normalized.company_website || ''));
      seenUrls.add(normalized.url);
      results.push(normalized);
    }
  }

  return results;
}

function extractApiBaseUrl(html) {
  const match = html.match(/const\s+gridBaseURL\s*=\s*'([^']*page\[size\]=)'\s*\+\s*pageSize/i);
  if (!match) return '';
  return match[1];
}

async function fetchApiBackedCompanies(adapter, html, sourceUrl, sourceHost, limit) {
  const apiBase = extractApiBaseUrl(html);
  if (!apiBase) return [];

  try {
    const apiUrl = `${apiBase}${Math.max(limit, 200)}`;
    const payload = await adapter.fetchJson(apiUrl);
    const companies = Array.isArray(payload?.data) ? payload.data : [];
    const included = Array.isArray(payload?.included) ? payload.included : [];
    const classMap = new Map();
    for (const item of included) {
      if (item?.type === 'alchemist_classes' && item.id) {
        classMap.set(String(item.id), cleanText(item.attributes?.number || ''));
      }
    }

    const results = [];
    const seen = new Set();
    for (const company of companies) {
      const title = normalizeCompanyLabel(stripVisitPrefix(company?.attributes?.name || ''));
      if (!looksLikeCompanyLabel(title)) continue;
      const slug = cleanText(company?.meta?.slug || '');
      const startupUrl = slug ? `https://vault.alchemistaccelerator.com/companies/public/${slug}` : '';
      const description = cleanText(company?.meta?.oneliner || company?.meta?.description || company?.meta?.startup_teamdescription || '');
      const country = cleanText(company?.meta?.location_formatted_address || '');
      const classNumber = classMap.get(String(company?.meta?.aclass_id || ''));
      const contentParts = [];
      if (description) contentParts.push(description);
      if (country) contentParts.push(country);
      if (classNumber) contentParts.push(`Class ${classNumber}`);
      const result = {
        title,
        url: startupUrl || sourceUrl,
        content: contentParts.join(' | ') || title,
        company_name: title,
        company_website: startupUrl || undefined,
        publishedAt: new Date().toISOString(),
        confidence: 0.8,
        signal_type: 'directory_listing',
      };
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      results.push(result);
      if (results.length >= limit) break;
    }

    return results;
  } catch {
    return [];
  }
}

function ycIndustryTokens(sourceUrl) {
  const urlObj = new URL(sourceUrl);
  const raw = cleanText(urlObj.searchParams.get('industry') || '')
    .toLowerCase()
    .replace(/-/g, ' ');
  return raw.split(/\s+/).filter((token) => token.length >= 3);
}

function matchesYCIndustry(company, sourceUrl) {
  const slug = cleanText(new URL(sourceUrl).searchParams.get('industry') || '').toLowerCase();
  const keywordMap = {
    'supply-chain-logistics-and-delivery': ['supply chain', 'logistics', 'delivery', 'freight', 'warehouse', 'shipping'],
    'industrials-and-manufacturing': ['manufacturing', 'industrial', 'factory', 'robotics', 'hardware'],
    agriculture: ['agriculture', 'agtech', 'farm', 'farming', 'livestock', 'food'],
  };
  const tokens = keywordMap[slug] || ycIndustryTokens(sourceUrl);
  if (tokens.length === 0) {
    return true;
  }
  const haystack = [
    ...(Array.isArray(company?.industries) ? company.industries : []),
    ...(Array.isArray(company?.tags) ? company.tags : []),
    cleanText(company?.oneLiner || ''),
    cleanText(company?.longDescription || ''),
  ].join(' ').toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

async function fetchYCCompanies(adapter, sourceUrl, limit) {
  const results = [];
  const seenDomains = new Set();
  const urlObj = new URL(sourceUrl);
  const batch = urlObj.searchParams.get('batch') || '';

  let page = 1;
  while (results.length < limit) {
    const params = new URLSearchParams({ page: String(page) });

    const apiUrl = `https://api.ycombinator.com/v0.1/companies?${params.toString()}`;
    const data = await adapter.fetchJson(apiUrl);
    const companies = Array.isArray(data?.companies) ? data.companies : [];
    if (companies.length === 0) {
      break;
    }

    for (const company of companies) {
      if (results.length >= limit) {
        break;
      }

      const name = stripVisitPrefix(cleanText(company?.name || ''));
      if (!name || name.length < 2) {
        continue;
      }

      if (batch && cleanText(company?.batch || '') !== batch) {
        continue;
      }

      if (!matchesYCIndustry(company, sourceUrl)) {
        continue;
      }

      const website = cleanText(company?.website || '');
      const companyWebsite = /^https?:\/\//i.test(website) ? website : '';
      const companyDomain = getRootDomain(companyWebsite);
      if (companyDomain && seenDomains.has(companyDomain)) {
        continue;
      }

      const description = cleanText(company?.oneLiner || company?.longDescription || '');
      const slug = cleanText(company?.slug || '');
      const fallbackUrl = slug ? `https://www.ycombinator.com/companies/${slug}` : sourceUrl;
      const thesisTags = Array.isArray(company?.tags) ? company.tags.filter(Boolean).map((tag) => cleanText(tag)).filter(Boolean) : [];

      results.push({
        title: name,
        url: companyWebsite || fallbackUrl,
        content: description || name,
        company_name: name,
        company_website: companyWebsite || undefined,
        publishedAt: new Date().toISOString(),
        confidence: 0.9,
        signal_type: 'cohort_page_scrape',
        thesis_tags: thesisTags,
      });

      if (companyDomain) {
        seenDomains.add(companyDomain);
      }
    }

    if (companies.length < 20) {
      break;
    }
    page += 1;
    if (page > 100) {
      break;
    }
  }

  return results;
}

class HtmlListAdapter extends BaseAdapter {
  async run({ query }) {
    const url = this.resolveUrl(query);
    const sourceUrl = this.source.method.url;
    const sourceHost = getHost(sourceUrl);
    const extractConfig = this.source.method?.extract || {};
    const profile = workbookProfile(this.source) || {};
    const fallbackLimit = Number.isInteger(profile.limit) ? profile.limit : (
      this.source.workbook_adapter === 'speaker_list'
        ? 120
        : this.source.workbook_adapter === 'exhibitor_list'
          ? 300
          : this.source.workbook_adapter === 'attendee_search'
            ? 300
            : 200
    );
    const limit = Number.isInteger(extractConfig.limit) ? extractConfig.limit : fallbackLimit;

    if (sourceUrl.includes('ycombinator.com')) {
      return fetchYCCompanies(this, sourceUrl, limit);
    }

    const html = this.options?._htmlOverride || await this.fetchText(url);
    const $ = cheerio.load(html);

    const structuredResults = parseCompaniesDataAttributes($, sourceUrl, sourceHost, limit);
    if (structuredResults.length > 0) {
      return structuredResults.slice(0, limit);
    }

    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        const nextDataResults = extractCompaniesFromNextData(nextData, this.source, sourceUrl, sourceHost, limit);
        if (nextDataResults.length > 0) {
          return nextDataResults.slice(0, limit);
        }
      } catch {
        // fall through to adapter fallback paths
      }
    }

    const apiResults = await fetchApiBackedCompanies(this, html, sourceUrl, sourceHost, limit);
    if (apiResults.length > 0) {
      return apiResults.slice(0, limit);
    }

    const itemSelectors = toSelectorList(firstNonEmpty(extractConfig.itemSelector, profile.itemSelectors), 'a[href]');
    const linkSelectors = toSelectorList(firstNonEmpty(extractConfig.linkSelector, profile.linkSelectors), null);
    const titleSelectors = toSelectorList(firstNonEmpty(extractConfig.titleSelector, profile.titleSelectors), null);
    const contentSelectors = toSelectorList(firstNonEmpty(extractConfig.contentSelector, profile.contentSelectors), null);
    const companyNameSelectors = toSelectorList(extractConfig.companyNameSelector, null);
    const companyWebsiteSelectors = toSelectorList(extractConfig.companyWebsiteSelector, null);
    const excludeSelectors = toSelectorList(extractConfig.excludeSelectors, null);
    const urlAttribute = extractConfig.urlAttribute || 'href';
    const itemUrlAttribute = extractConfig.itemUrlAttribute || null;
    const titleAttribute = extractConfig.titleAttribute || null;
    const contentAttribute = extractConfig.contentAttribute || null;
    const companyNameAttribute = extractConfig.companyNameAttribute || null;
    const companyWebsiteUrlAttribute = extractConfig.companyWebsiteUrlAttribute || 'href';
    const mergeContentSelectors = extractConfig.mergeContentSelectors === true;
    const contentJoinWith = extractConfig.contentJoinWith || ' ';
    const excludePatterns = Array.isArray(extractConfig.excludePatterns)
      ? extractConfig.excludePatterns.map((pattern) => new RegExp(pattern, 'i'))
      : [];
    const includePatterns = Array.isArray(extractConfig.includePatterns)
      ? extractConfig.includePatterns.map((pattern) => new RegExp(pattern, 'i'))
      : [];
    const detailPageWebsiteCache = new Map();
    const maxDetailPageLookups = Number.isInteger(extractConfig.maxDetailPageLookups)
      ? extractConfig.maxDetailPageLookups
      : 40;
    let detailPageLookupCount = 0;
    const seenUrls = new Set();
    const results = [];
    const inventorySource = looksLikeInventorySource(this.source);

    for (const itemSelector of itemSelectors) {
      const elements = $(itemSelector).toArray();
      for (const element of elements) {
        if (results.length >= limit) {
          break;
        }

        const node = $(element);
        const nodeHtml = cleanText(node.html() || '');
        if (/\/article\//i.test(nodeHtml)) {
          continue;
        }
        if (node.is('.splide__slide') || node.find('.splide__card a[href*="/article/"]').length > 0) {
          continue;
        }

        if (
          excludeSelectors.some((selector) => node.is(selector) || node.find(selector).length > 0)
        ) {
          continue;
        }

        const linkNode = firstMatchingNode($, node, linkSelectors, node);
        const titleNode = firstMatchingNode($, node, titleSelectors, linkNode || node);
        const contentNode = mergeContentSelectors
          ? null
          : firstMatchingNode($, node, contentSelectors, null);
        const companyNameNode = firstMatchingNode($, node, companyNameSelectors, null);
        const companyWebsiteNode = firstMatchingNode($, node, companyWebsiteSelectors, null);
        const href =
          (linkNode && linkNode.attr(urlAttribute)) ||
          (itemUrlAttribute ? node.attr(itemUrlAttribute) : '') ||
          '';
        const title = stripVisitPrefix(readNodeValue(titleNode, titleAttribute));
        const content = (
          mergeContentSelectors
            ? readMergedValues($, node, contentSelectors, contentAttribute, contentJoinWith)
            : readNodeValue(contentNode, contentAttribute)
        ) || title;
        const companyName = stripVisitPrefix(readNodeValue(companyNameNode, companyNameAttribute));
        const companyWebsite = companyWebsiteNode
          ? new URL(companyWebsiteNode.attr(companyWebsiteUrlAttribute), this.source.method.url).toString()
          : '';

        if (!href) {
          continue;
        }

        const absoluteUrl = new URL(href, this.source.method.url).toString();
        const earlyCompanyWebsiteFallback = inferCompanyWebsiteFromLink(absoluteUrl, sourceHost);
        if ((!title || title.length < 2) && !(inventorySource && earlyCompanyWebsiteFallback)) {
          continue;
        }
        const genericCandidateName = pickStrongCompanyName($, node, linkNode, titleNode, companyName, title, absoluteUrl);
        let normalizedTitle = preferredCompanyName(genericCandidateName, companyName || title, absoluteUrl);
        let companyWebsiteFallback = earlyCompanyWebsiteFallback;
        const pathLooksLikeDetail = DETAIL_PATH_PATTERNS.some((pattern) => pattern.test(new URL(absoluteUrl).pathname || '/'));
        const haystack = [absoluteUrl, normalizedTitle, content].join(' ');

        if (excludePatterns.some((pattern) => pattern.test(haystack))) {
          continue;
        }

        if (!extractConfig.itemSelector && isBlockedUrl(absoluteUrl, sourceHost)) {
          continue;
        }

        if (includePatterns.length > 0 && !includePatterns.some((pattern) => pattern.test(haystack))) {
          continue;
        }

        if (seenUrls.has(absoluteUrl)) {
          continue;
        }

        if (!looksLikeCompanyLabel(normalizedTitle) && inventorySource && companyWebsiteFallback) {
          normalizedTitle = preferredCompanyName('', titleFromCompanyWebsite(companyWebsiteFallback), companyWebsiteFallback);
        }

        if (!looksLikeCompanyLabel(normalizedTitle)) {
          continue;
        }

        if (looksLikeSourceBrandSelfLink(this.source, normalizedTitle, companyWebsite || companyWebsiteFallback || absoluteUrl)) {
          continue;
        }

        if (!extractConfig.itemSelector) {
          if (!companyWebsiteFallback && pathLooksLikeDetail) {
            if (detailPageWebsiteCache.has(absoluteUrl)) {
              companyWebsiteFallback = detailPageWebsiteCache.get(absoluteUrl);
            } else if (detailPageLookupCount < maxDetailPageLookups) {
              detailPageLookupCount += 1;
              companyWebsiteFallback = await resolveDetailPageCompanyWebsite(this, absoluteUrl, sourceHost);
              detailPageWebsiteCache.set(absoluteUrl, companyWebsiteFallback);
            }
          }

          if (!companyWebsiteFallback && !inventorySource) {
            continue;
          }

          if (companyWebsiteFallback && isBlockedUrl(companyWebsiteFallback, '')) {
            continue;
          }
        }

        seenUrls.add(absoluteUrl);
        results.push({
          title: normalizedTitle || title,
          url: absoluteUrl,
          content,
          company_name: normalizedTitle || undefined,
          company_website: companyWebsite || companyWebsiteFallback || undefined,
          publishedAt: new Date().toISOString(),
          confidence: inventorySource ? 0.68 : 0.55,
          signal_type: 'directory_listing',
        });
      }

      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }
}

module.exports = {
  HtmlListAdapter,
};
