class BaseAdapter {
  constructor(source, options = {}) {
    this.source = source;
    this.options = options;
    this.timeoutMs = options.timeoutMs || 10000;
    this.userAgent = options.userAgent || 'Searchbar3-Sourcing/1.0';
  }

  resolveUrl(query) {
    const template = this.source.method?.url || '';
    return template.replace('{{query}}', encodeURIComponent(query || ''));
  }

  async fetchText(url) {
    await this.ensureRobotsAllowed(url);
    const response = await this.fetchWithTimeout(url, this.timeoutMs);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.text();
  }

  async fetchJson(url) {
    await this.ensureRobotsAllowed(url);
    const response = await this.fetchWithTimeout(url, this.timeoutMs);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  async run() {
    throw new Error('Adapter must implement run()');
  }

  shouldRespectRobots() {
    return Boolean(this.source?.runtime?.respectRobots);
  }

  async fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await Promise.race([
        fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': this.userAgent,
          },
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs + 50);
        }),
      ]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async ensureRobotsAllowed(url) {
    if (!this.shouldRespectRobots()) {
      return;
    }

    let robotsText = '';
    try {
      const robotsUrl = new URL('/robots.txt', url).toString();
      const response = await this.fetchWithTimeout(robotsUrl, Math.min(this.timeoutMs, 5000));

      if (!response.ok) {
        return;
      }

      robotsText = await response.text();
    } catch {
      // Fail-open for robots retrieval errors to avoid taking down sourcing.
      return;
    }

    if (!robotsText) {
      return;
    }

    const targetPath = (() => {
      try {
        const parsed = new URL(url);
        return `${parsed.pathname || '/'}${parsed.search || ''}`;
      } catch {
        return '/';
      }
    })();

    if (!isPathAllowedByRobots(robotsText, targetPath, this.userAgent)) {
      throw new Error(`Blocked by robots.txt policy for ${targetPath}`);
    }
  }
}

function isPathAllowedByRobots(robotsText, targetPath, userAgent) {
  const groups = parseRobotsGroups(robotsText);
  if (groups.length === 0) {
    return true;
  }

  const ua = String(userAgent || '').toLowerCase();
  const exactMatch = groups.find((group) => group.userAgents.some((name) => ua.includes(name)));
  const wildcardMatch = groups.find((group) => group.userAgents.includes('*'));
  const activeGroup = exactMatch || wildcardMatch;
  if (!activeGroup) {
    return true;
  }

  const rules = activeGroup.rules.filter((rule) => rule.path.length > 0);
  if (rules.length === 0) {
    return true;
  }

  const matching = rules
    .filter((rule) => targetPath.startsWith(rule.path))
    .sort((left, right) => right.path.length - left.path.length);

  if (matching.length === 0) {
    return true;
  }

  return matching[0].type !== 'disallow';
}

function parseRobotsGroups(robotsText) {
  const lines = String(robotsText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  const groups = [];
  let current = null;

  for (const line of lines) {
    const parts = line.split(':');
    if (parts.length < 2) {
      continue;
    }

    const key = parts.shift().trim().toLowerCase();
    const value = parts.join(':').trim();

    if (key === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { userAgents: [], rules: [] };
        groups.push(current);
      }
      current.userAgents.push(value.toLowerCase());
      continue;
    }

    if (!current) {
      continue;
    }

    if (key === 'allow' || key === 'disallow') {
      current.rules.push({ type: key, path: value || '/' });
    }
  }

  return groups;
}

module.exports = {
  BaseAdapter,
};
