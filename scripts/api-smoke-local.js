#!/usr/bin/env node

const { spawn } = require('child_process');

const BASE = process.env.API_SMOKE_BASE || 'http://127.0.0.1:3001';
const START_TIMEOUT_MS = 90000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs, shouldAbort) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (typeof shouldAbort === 'function') {
      const reason = shouldAbort();
      if (reason) {
        throw new Error(reason);
      }
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (_error) {
      // Server not ready yet.
    }

    await sleep(1000);
  }

  throw new Error(`Timed out waiting for server at ${url}`);
}

async function isServerReady(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch (_error) {
    return false;
  }
}

function runCommand(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: { ...process.env, ...env },
      shell: process.platform === 'win32',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}

async function main() {
  const healthUrl = `${BASE}/api/debug/env-check`;
  const parsedBase = new URL(BASE);
  const host = parsedBase.hostname;
  const port = parsedBase.port || (parsedBase.protocol === 'https:' ? '443' : '80');
  let startProcess = null;
  let startedByScript = false;

  if (!(await isServerReady(healthUrl))) {
    startProcess = spawn('npm', ['run', 'start', '--', '-H', host, '-p', port], {
      stdio: 'inherit',
      env: { ...process.env },
      shell: process.platform === 'win32',
    });
    startedByScript = true;
  } else {
    console.log(`Reusing existing server at ${BASE}`);
  }

  const cleanup = () => {
    if (startedByScript && startProcess && !startProcess.killed) {
      startProcess.kill('SIGTERM');
    }
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  try {
    await waitForServer(healthUrl, START_TIMEOUT_MS, () => {
      if (startedByScript && startProcess && startProcess.exitCode !== null && startProcess.exitCode !== 0) {
        return `Server process exited early with code ${startProcess.exitCode}`;
      }

      return null;
    });
    await runCommand('node', ['scripts/api-smoke.js'], { API_SMOKE_BASE: BASE });
    console.log('PASS api-smoke-local');
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(`FAIL api-smoke-local: ${error.message}`);
  process.exit(1);
});
