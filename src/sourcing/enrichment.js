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

module.exports = {
  buildWebsiteEnrichment,
  inferRootDomain,
};
