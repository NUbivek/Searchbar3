import path from 'path';
import { execFile } from 'child_process';

function runAdapter({ profile, runId, outputDir, timeoutMs }) {
  const repoRoot = process.env.SOURCE_AND_SEARCH_ROOT || path.resolve(process.cwd(), '..');
  const scriptPath = path.join(repoRoot, 'scripts', 'run-sourcing101-adapter.sh');

  return new Promise((resolve, reject) => {
    execFile(
      scriptPath,
      [profile, runId, outputDir],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          return reject({ error, stderr });
        }
        resolve(String(stdout || '').trim());
      }
    );
  });
}

const companies = [
  ['AetherOps', 'aetherops.ai', 'AI finops platform that optimizes cloud spend across engineering teams.'],
  ['HelioForge', 'helioforge.com', 'Forecasting and dispatch software for distributed solar operators.'],
  ['NexThread', 'nexthread.io', 'Customer support QA copilot for high-volume B2B support teams.'],
  ['VerityFlow', 'verityflow.dev', 'Runtime guardrails and observability stack for production AI apps.'],
  ['QuantaFleet', 'quantafleet.com', 'Route, utilization, and spoilage intelligence for logistics fleets.'],
  ['SableGrid', 'sablegrid.io', 'Grid edge control software for utilities and renewable operators.'],
  ['TandemBio', 'tandembio.co', 'Clinical trial operations workflow platform for biotech teams.'],
  ['LumenDraft', 'lumendraft.com', 'Contract intelligence assistant for in-house legal operations.'],
  ['Northbeam Labs', 'northbeamlabs.com', 'Security posture automation for mid-market enterprise infra.'],
  ['CatalystFarm', 'catalystfarm.ai', 'Precision agriculture intelligence for growers and processors.'],
  ['OrbitMint', 'orbitmint.io', 'Revenue operations automation for modern SaaS GTM teams.'],
  ['PulseFoundry', 'pulsefoundry.ai', 'Procurement optimization platform for industrial buyers.']
];

const stages = ['Pre-seed', 'Seed', 'Series A', 'Series B'];
const sources = ['TechCrunch', 'Sifted', 'YC', 'Hacker News', 'The Information', 'Crunchbase'];
const statuses = ['new', 'reviewed', 'shortlisted', 'contacted'];

const mockSignals = Array.from({ length: 240 }, (_, i) => {
  const c = companies[i % companies.length];
  const fundingUsd = [0, 750000, 2200000, 6800000, 18000000, 42000000][i % 6];
  const headcount = [6, 11, 18, 27, 42, 63, 95][i % 7];
  const investorTier = ['tier-1', 'tier-2', 'tier-3'][i % 3];
  const hqCountry = ['US', 'CA', 'GB', 'DE', 'IL'][i % 5];
  return {
    id: `sig-${i + 1}`,
    startupName: c[0],
    url: `https://${c[1]}`,
    description: c[2],
    stage: stages[i % stages.length],
    source: sources[i % sources.length],
    status: statuses[i % statuses.length],
    fundingUsd,
    headcount,
    investorTier,
    hqCountry,
    confidence: Number((0.58 + (i % 35) / 100).toFixed(2)),
    detectedAt: new Date(Date.now() - i * 1000 * 60 * 60 * 8).toISOString(),
  };
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    profile = 'github',
    runId = `run-${Date.now()}`,
    outputDir = '/tmp/source-and-search',
    mock = process.env.SOURCING101_STUB === '1',
    timeoutMs = 120000,
  } = req.body || {};

  if (mock) {
    return res.status(200).json({
      status: 'ok',
      artifacts: {
        latestCsvPath: 'sourcing101/startup_watch/output/latest.csv',
        timestampedCsvPath: 'sourcing101/startup_watch/output/startup_watch_YYYYMMDD_HHMMSS.csv',
        contractJsonPath: '/tmp/source-and-search/mock/adapter-result.json',
      },
      summary: {
        runId,
        profile,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 240,
        warnings: ['mock mode'],
      },
      totalSignals: mockSignals.length,
      signalsPreview: mockSignals,
      error: null,
      mode: 'stub',
    });
  }

  try {
    const contractJsonPath = await runAdapter({ profile, runId, outputDir, timeoutMs });
    return res.status(200).json({
      status: 'ok',
      contractJsonPath,
      mode: 'live',
    });
  } catch (e) {
    const message = e?.error?.message || 'Adapter execution failed';
    return res.status(200).json({
      status: 'degraded',
      error: message,
      details: e?.stderr || null,
      mode: 'live',
    });
  }
}
