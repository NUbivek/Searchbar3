export function getApiBaseUrl() {
  const configured = String(process.env.NEXT_PUBLIC_API_BASE_URL || '').trim();
  return configured.replace(/\/+$/, '');
}

export function buildApiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const baseUrl = getApiBaseUrl();
  return baseUrl ? `${baseUrl}${normalizedPath}` : normalizedPath;
}
