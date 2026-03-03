function safeHostname(value) {
  if (!value) {
    return '';
  }

  try {
    return new URL(value).hostname.toLowerCase();
  } catch (error) {
    return '';
  }
}

function canonicalizeUrl(value) {
  if (!value) {
    return '';
  }

  try {
    const parsed = new URL(value);
    parsed.hash = '';

    const blockedParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref'];
    for (const param of blockedParams) {
      parsed.searchParams.delete(param);
    }

    const pathname = parsed.pathname.endsWith('/') && parsed.pathname !== '/'
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;

    parsed.pathname = pathname;
    return parsed.toString();
  } catch (error) {
    return value;
  }
}

function inferRootDomain(hostname) {
  const parts = String(hostname || '').split('.').filter(Boolean);
  if (parts.length < 2) {
    return hostname || '';
  }

  return parts.slice(-2).join('.');
}

function buildWebsiteEnrichment({ companyWebsite, itemUrl, sourceUrl }) {
  const normalizedCompanyWebsite = canonicalizeUrl(companyWebsite || '');
  const normalizedItemUrl = canonicalizeUrl(itemUrl || '');
  const normalizedSourceUrl = canonicalizeUrl(sourceUrl || '');

  const companyHostname = safeHostname(normalizedCompanyWebsite);
  const itemHostname = safeHostname(normalizedItemUrl);
  const sourceHostname = safeHostname(normalizedSourceUrl);

  const companyRootDomain = inferRootDomain(companyHostname);
  const itemRootDomain = inferRootDomain(itemHostname);
  const sourceRootDomain = inferRootDomain(sourceHostname);

  return {
    company_hostname: companyHostname,
    company_root_domain: companyRootDomain,
    item_hostname: itemHostname,
    item_root_domain: itemRootDomain,
    source_hostname: sourceHostname,
    source_root_domain: sourceRootDomain,
    uses_first_party_domain: Boolean(companyRootDomain && itemRootDomain && companyRootDomain === itemRootDomain),
    item_matches_source_domain: Boolean(sourceRootDomain && itemRootDomain && sourceRootDomain === itemRootDomain),
    has_distinct_company_website: Boolean(companyRootDomain && itemRootDomain && companyRootDomain !== itemRootDomain),
  };
}

function inferHiringSignals(text) {
  const content = String(text || '');
  const lower = content.toLowerCase();

  const explicitOpenRoles = lower.match(/(\d{1,3})\+?\s+(open roles|open positions|job openings)/i);
  const teamSize = lower.match(/(\d{1,4})\s*(employees|employee team|person team|person company)/i);
  const growthPct = lower.match(/(\d{1,3})%\s+(headcount growth|team growth|employee growth)/i);

  let hiringSignal = 'none';
  if (/\b(hiring|hiring across|now hiring|growing team|expanding team|we are hiring)\b/i.test(content)) {
    hiringSignal = 'active';
  }

  if (explicitOpenRoles) {
    hiringSignal = 'strong';
  }

  return {
    hiring_signal: hiringSignal,
    open_roles_guess: explicitOpenRoles ? Number(explicitOpenRoles[1]) : null,
    employee_count_guess: teamSize ? Number(teamSize[1]) : null,
    headcount_growth_pct_guess: growthPct ? Number(growthPct[1]) : null,
  };
}

function buildHiringEnrichment({ item }) {
  const content = `${item.title || ''} ${item.content || ''} ${item.snippet || ''}`.trim();
  return inferHiringSignals(content);
}

function inferFundingSignals(text) {
  const content = String(text || '');

  const roundPatterns = [
    { type: 'pre-seed', pattern: /\bpre[\s-]?seed\b/i },
    { type: 'seed', pattern: /\bseed round\b|\bseed financing\b|\braised seed\b/i },
    { type: 'series_a', pattern: /\bseries\s+a\b/i },
    { type: 'series_b', pattern: /\bseries\s+b\b/i },
    { type: 'series_c', pattern: /\bseries\s+c\b/i },
    { type: 'growth', pattern: /\bgrowth round\b|\bseries\s+d\b|\bseries\s+e\b/i },
  ];

  const amountMatch = content.match(/(?:\$|usd\s*)(\d+(?:\.\d+)?)\s*(m|mm|million|b|bn|billion|k|thousand)?/i);
  const eurMatch = content.match(/(?:€|eur\s*)(\d+(?:\.\d+)?)\s*(m|mm|million|b|bn|billion|k|thousand)?/i);
  const gbpMatch = content.match(/(?:£|gbp\s*)(\d+(?:\.\d+)?)\s*(m|mm|million|b|bn|billion|k|thousand)?/i);

  let fundingRound = 'unknown';
  for (const entry of roundPatterns) {
    if (entry.pattern.test(content)) {
      fundingRound = entry.type;
      break;
    }
  }

  const amountSource = amountMatch || eurMatch || gbpMatch;
  let amount = null;

  if (amountSource) {
    amount = Number(amountSource[1]);
    const suffix = (amountSource[2] || '').toLowerCase();

    if (['k', 'thousand'].includes(suffix)) {
      amount *= 1_000;
    } else if (['m', 'mm', 'million'].includes(suffix)) {
      amount *= 1_000_000;
    } else if (['b', 'bn', 'billion'].includes(suffix)) {
      amount *= 1_000_000_000;
    }
  }

  let currency = null;
  if (amountMatch) {
    currency = 'USD';
  } else if (eurMatch) {
    currency = 'EUR';
  } else if (gbpMatch) {
    currency = 'GBP';
  }

  const fundingSignal = amount || fundingRound !== 'unknown' ? 'present' : 'none';

  return {
    funding_signal: fundingSignal,
    funding_round_guess: fundingRound,
    funding_amount_guess: amount,
    funding_currency_guess: currency,
  };
}

function buildFundingEnrichment({ item }) {
  const content = `${item.title || ''} ${item.content || ''} ${item.snippet || ''}`.trim();
  return inferFundingSignals(content);
}

module.exports = {
  buildFundingEnrichment,
  buildHiringEnrichment,
  buildWebsiteEnrichment,
  inferFundingSignals,
  inferRootDomain,
  inferHiringSignals,
};
