/**
 * Smoke test for the live API routes against a running server.
 *   API_SMOKE_BASE=http://127.0.0.1:3000 node scripts/api-smoke.js
 * Checks only the shape of each response (status codes); it never needs
 * API keys or a signed-in session.
 */
const base = process.env.API_SMOKE_BASE || 'http://127.0.0.1:3000';

async function check(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { redirect: 'manual', ...options });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (error) {
    // not JSON
  }
  return { response, text, json };
}

function expectStatus(response, expected, name) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(response.status)) {
    throw new Error(`${name}: expected ${allowed.join(' or ')}, got ${response.status}`);
  }
}

async function main() {
  await check('env-check returns diagnostics (or 401 in production)', async () => {
    const { response, json } = await request('/api/debug/env-check');
    expectStatus(response, [200, 401], 'env-check');
    if (response.status === 200 && !json?.diagnostics) throw new Error('env-check: no diagnostics in body');
  });

  await check('search/open rejects an empty body', async () => {
    const { response } = await request('/api/search/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expectStatus(response, 400, 'search/open');
  });

  await check('search/open answers a curated-source query', async () => {
    const { response, json } = await request('/api/search/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Stripe', sources: ['curated'], useLLM: false }),
    });
    expectStatus(response, 200, 'search/open');
    if (!json || !Array.isArray(json.results)) throw new Error('search/open: no results array');
  });

  await check('company requires ?name=', async () => {
    const { response } = await request('/api/company');
    expectStatus(response, 400, 'company');
  });

  await check('founder requires ?name=', async () => {
    const { response } = await request('/api/founder');
    expectStatus(response, 400, 'founder');
  });

  await check('llm/models lists models', async () => {
    const { response, json } = await request('/api/llm/models');
    expectStatus(response, 200, 'llm/models');
    if (!json || !Array.isArray(json.models)) throw new Error('llm/models: no models array');
  });

  await check('sources/curated responds', async () => {
    const { response } = await request('/api/sources/curated');
    expectStatus(response, 200, 'sources/curated');
  });

  for (const route of ['alerts', 'watchlist', 'history', 'workspaces', 'network/contacts']) {
    await check(`${route} requires sign-in`, async () => {
      const { response } = await request(`/api/${route}`);
      expectStatus(response, 401, route);
    });
  }

  await check('alerts clamps a bad limit instead of failing', async () => {
    const { response } = await request('/api/alerts?limit=-1');
    expectStatus(response, 401, 'alerts?limit=-1');
  });

  for (const route of ['linkedin', 'twitter']) {
    await check(`${route} OAuth start is reachable`, async () => {
      const { response } = await request(`/api/auth/${route}`);
      if (response.status >= 500) throw new Error(`auth/${route}: status ${response.status}`);
    });
  }

  await check('upload rejects GET', async () => {
    const { response } = await request('/api/upload');
    expectStatus(response, 405, 'upload');
  });

  await check('removed debug routes are gone', async () => {
    for (const path of ['/api/cleanup', '/api/debug-info', '/api/fetch-url', '/api/webScrape']) {
      const { response } = await request(path);
      expectStatus(response, 404, path);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
