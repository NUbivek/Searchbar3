const { fetchUrlContent } = require('../../utils/urlExtraction');
const { logger } = require('../../utils/logger');

function getRequestedUrl(req) {
  if (req.method === 'GET') {
    return req.query?.url;
  }

  return req.body?.url;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const url = getRequestedUrl(req);
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const payload = await fetchUrlContent(url, {
    timeoutMs: 10000,
    maxBytes: 1024 * 1024,
    textLimit: 8000
  });

  if (payload.status === 'error') {
    logger.warn('URL fetch failed', { url, error: payload.error });
  }

  return res.status(200).json(payload);
}
