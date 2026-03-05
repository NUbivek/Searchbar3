export function getApiBaseUrl() {
  const configured = String(process.env.NEXT_PUBLIC_API_BASE_URL || '').trim();
  return configured.replace(/\/+$/, '');
}

export function buildApiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const baseUrl = getApiBaseUrl();
  return baseUrl ? `${baseUrl}${normalizedPath}` : normalizedPath;
}

export async function postSearchRequest(payload = {}) {
  const endpoint = buildApiUrl('/api/search/open');
  const body = new URLSearchParams();

  if (payload.query) body.set('query', payload.query);
  if (payload.model) body.set('model', payload.model);
  body.set('mode', payload.mode || 'open');
  body.set('useLLM', String(payload.useLLM !== false));

  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  for (const source of sources) {
    body.append('sources', source);
  }

  const customUrls = Array.isArray(payload.customUrls) ? payload.customUrls : [];
  for (const url of customUrls) {
    body.append('customUrls', url);
  }

  const files = Array.isArray(payload.files) ? payload.files : [];
  for (const file of files) {
    body.append('files', typeof file === 'string' ? file : JSON.stringify(file));
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    throw new Error(`Server returned non-JSON response (status ${response.status})${text ? `: ${text.slice(0, 140)}` : ''}`);
  }

  const data = await response.json();
  if (!response.ok) {
    const message = data?.error || data?.message || `Search request failed (status ${response.status})`;
    throw new Error(message);
  }

  return data;
}
