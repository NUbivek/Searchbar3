const base = process.env.API_SMOKE_BASE || 'http://127.0.0.1:3001';

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
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch (error) {
    // ignore non-json
  }

  return { response, text, json };
}

async function main() {
  await check('env-check returns diagnostics', async () => {
    const { response, json } = await request('/api/debug/env-check');
    if (response.status !== 200 || !json?.diagnostics) {
      throw new Error(`Unexpected env-check response: ${response.status}`);
    }
  });

  await check('search empty body returns 400', async () => {
    const { response } = await request('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (response.status !== 400) {
      throw new Error(`Expected 400, got ${response.status}`);
    }
  });

  await check('search with query returns controlled response', async () => {
    const { response } = await request('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'test query',
        sources: ['Web'],
        mode: 'open',
      }),
    });

    if (![200, 500].includes(response.status)) {
      throw new Error(`Unexpected status ${response.status}`);
    }
  });

  for (const route of ['twitter', 'linkedin', 'reddit']) {
    await check(`${route} oauth route reachable`, async () => {
      const { response } = await request(`/api/auth/${route}`);
      if (response.status < 200 || response.status >= 500) {
        throw new Error(`Unexpected status ${response.status}`);
      }
    });
  }

  await check('fetch-url rejects missing url', async () => {
    const { response } = await request('/api/fetch-url');
    if (response.status !== 400) {
      throw new Error(`Expected 400, got ${response.status}`);
    }
  });

  await check('upload rejects GET', async () => {
    const { response } = await request('/api/upload');
    if (response.status !== 405) {
      throw new Error(`Expected 405, got ${response.status}`);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
