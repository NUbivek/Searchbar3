#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const SIGNALS_PATH = path.join(process.cwd(), 'data', 'signals.jsonl');
const DESC_CACHE_PATH = path.join(process.cwd(), 'data', 'description_cache.json');
const REQUEST_TIMEOUT = 7000;
const DELAY_MS = 800;

function loadCache(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

async function getFetch() {
  return (await import('node-fetch')).default;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isJunkDescription(description) {
  const text = stripHtml(description);
  if (!text || text.length < 30) return true;
  if (/^listed in .+ portfolio/i.test(text)) return true;
  if (/sector tags:/i.test(text)) return true;
  if (/portfolio company\. focus:/i.test(text)) return true;
  if (/scrape|crawl|html|css selector/i.test(text)) return true;
  if (/^[\w\s]+ portfolio company/i.test(text)) return true;
  return false;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanDescription(raw, companyName) {
  if (!raw) return null;
  let value = stripHtml(raw)
    .replace(new RegExp(`^${escapeRegExp(companyName)}\\s*[-–—|]\\s*`, 'i'), '')
    .replace(/\s*[-–—|]\s*(visit us|learn more|click here|.{1,20}\.com)$/i, '')
    .trim();

  if (value.length < 30 || value.length > 300) return null;
  if (/^(we are|we help|the (future|platform|solution)|building the|reimagining|transforming|disrupting|the #1|the leading|the best)/i.test(value) && value.length < 60) {
    return null;
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function fetchFromWebsite(domain, companyName) {
  const fetch = await getFetch();
  const urls = [`https://${domain}`, `https://www.${domain}`];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        redirect: 'follow',
      });
      if (!response.ok || response.status === 401 || response.status === 403) continue;
      const html = await response.text();

      const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{30,300})["']/i);
      if (ogDesc) {
        const desc = cleanDescription(ogDesc[1], companyName);
        if (desc) return { desc, source: 'website og:description' };
      }

      const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{30,300})["']/i);
      if (metaDesc) {
        const desc = cleanDescription(metaDesc[1], companyName);
        if (desc) return { desc, source: 'website meta:description' };
      }

      const twitterDesc = html.match(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']{30,300})["']/i);
      if (twitterDesc) {
        const desc = cleanDescription(twitterDesc[1], companyName);
        if (desc) return { desc, source: 'website twitter:description' };
      }
    } catch {
      // fall through to next source
    }
  }

  return null;
}

async function fetchFromGoogleNews(companyName, domain) {
  const fetch = await getFetch();
  const query = encodeURIComponent(`"${companyName}"`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/rss+xml,text/xml',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!response.ok) return null;
    const xml = await response.text();
    const items = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<\/item>/g)]
      .map((match) => ({
        title: stripHtml(match[1]),
        desc: stripHtml(match[2]),
      }));

    const root = String(domain || '').split('.')[0].toLowerCase();
    const firstWord = String(companyName || '').toLowerCase().split(' ')[0];

    for (const item of items.slice(0, 5)) {
      const title = item.title.toLowerCase();
      if (!title.includes(firstWord) && !title.includes(root)) continue;
      if (!/raises|launches|expands|partners|platform|software|solution|product|service|ai|startup|company|announces/i.test(item.title)) continue;
      const desc = cleanDescription(item.desc || item.title, companyName);
      if (desc && desc.length >= 40) return { desc, source: 'Google News snippet' };
    }
  } catch {
    // ignore
  }

  return null;
}

function heuristicDescription(signal) {
  const tags = Array.isArray(signal.thesis_tags) ? signal.thesis_tags : [];
  const sourceName = signal.source_name || '';
  if (!tags.length) return null;
  const top = tags.slice(0, 3).join(', ');
  return `${sourceName} portfolio company focused on ${top.toLowerCase()}.`;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const highOnly = args.includes('--high-only');
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0 ? parseInt(args[limitIndex + 1], 10) : 2000;

  const signals = fs.readFileSync(SIGNALS_PATH, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const cache = loadCache(DESC_CACHE_PATH);

  const seen = new Set();
  const toEnrich = [];
  for (const signal of signals) {
    const domain = signal.company_domain;
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    if (highOnly && signal.signal_weight !== 'high') continue;
    if (cache[domain] && !isJunkDescription(cache[domain])) continue;
    if (!isJunkDescription(signal.description)) {
      cache[domain] = signal.description;
      continue;
    }
    toEnrich.push(signal);
  }

  const targets = toEnrich.slice(0, limit);
  console.log(`Enriching descriptions for ${targets.length} companies...`);

  if (dryRun) {
    targets.slice(0, 10).forEach((target) => console.log(`  ${target.company_name} (${target.company_domain})`));
    return;
  }

  let websiteHits = 0;
  let newsHits = 0;
  let heuristicHits = 0;

  for (let i = 0; i < targets.length; i += 1) {
    const signal = targets[i];
    let result = await fetchFromWebsite(signal.company_domain, signal.company_name);
    if (result) websiteHits += 1;

    if (!result) {
      result = await fetchFromGoogleNews(signal.company_name, signal.company_domain);
      if (result) newsHits += 1;
    }

    if (!result) {
      const desc = heuristicDescription(signal);
      if (desc) {
        result = { desc, source: 'heuristic' };
        heuristicHits += 1;
      }
    }

    if (result) {
      cache[signal.company_domain] = result.desc;
    }

    if (i % 20 === 0 || i === targets.length - 1) {
      fs.writeFileSync(DESC_CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
      process.stdout.write(`\r  ${i + 1}/${targets.length} | website:${websiteHits} news:${newsHits} heuristic:${heuristicHits}`);
    }
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  console.log(`\nDone. website:${websiteHits} news:${newsHits} heuristic:${heuristicHits}`);

  let applied = 0;
  const output = signals.map((signal) => {
    const desc = cache[signal.company_domain];
    if (desc && isJunkDescription(signal.description)) {
      signal.description = desc;
      applied += 1;
    }
    return JSON.stringify(signal);
  });
  fs.writeFileSync(SIGNALS_PATH, output.join('\n') + '\n');
  console.log(`Applied ${applied} descriptions to signals.jsonl`);

  let shown = 0;
  for (const [domain, desc] of Object.entries(cache)) {
    if (shown >= 5) break;
    console.log(`  ${domain}: ${desc}`);
    shown += 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
