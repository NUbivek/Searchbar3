const axios = require('axios');
const { load } = require('cheerio');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TEXT_LIMIT = 8000;

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTextFromHtml(html, textLimit = DEFAULT_TEXT_LIMIT) {
  const $ = load(html || '');

  $('script, style, noscript, iframe, svg').remove();

  const title = normalizeWhitespace($('title').first().text());
  const description = normalizeWhitespace(
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    ''
  );

  const bodyText = normalizeWhitespace($('body').text()).slice(0, textLimit);

  return {
    title: title || null,
    description: description || null,
    content: bodyText || ''
  };
}

async function fetchUrlContent(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
  const textLimit = Number(options.textLimit) > 0 ? Number(options.textLimit) : DEFAULT_TEXT_LIMIT;

  if (!isValidHttpUrl(url)) {
    return {
      url,
      status: 'error',
      title: null,
      description: null,
      content: '',
      error: 'Invalid URL'
    };
  }

  try {
    const response = await axios.get(url, {
      timeout: timeoutMs,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      responseType: 'text',
      headers: {
        'User-Agent': 'Searchbar3/1.0 URL Fetcher'
      },
      validateStatus: (status) => status >= 200 && status < 400
    });

    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      return {
        url,
        status: 'error',
        title: null,
        description: null,
        content: '',
        error: `Unsupported content type: ${contentType}`
      };
    }

    const extracted = extractTextFromHtml(response.data, textLimit);
    if (!extracted.content) {
      return {
        url,
        status: 'empty',
        title: extracted.title,
        description: extracted.description,
        content: '',
        error: null
      };
    }

    return {
      url,
      status: 'ok',
      title: extracted.title,
      description: extracted.description,
      content: extracted.content,
      error: null
    };
  } catch (error) {
    return {
      url,
      status: 'error',
      title: null,
      description: null,
      content: '',
      error: error.message || 'Failed to fetch URL'
    };
  }
}

function buildUrlSearchResult(payload) {
  if (!payload || payload.status === 'error' || !payload.content) {
    return null;
  }

  return {
    title: payload.title || payload.url,
    content: payload.content,
    url: payload.url,
    source: 'custom',
    type: 'custom_url',
    relevance: 0.8,
    metadata: {
      description: payload.description || null
    }
  };
}

module.exports = {
  fetchUrlContent,
  buildUrlSearchResult
};
