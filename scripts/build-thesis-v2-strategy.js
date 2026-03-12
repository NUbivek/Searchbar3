const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const registryPath = path.join(ROOT, 'sources', 'registry.json');
const outPath = path.join(ROOT, 'sources', 'thesis_v2_strategy.json');

const mustHaveSources = [
  { id: 'U-01', name: 'MIT Delta V', region: 'US', url: 'https://entrepreneurship.mit.edu/delta-v/', category: 'university_incubator' },
  { id: 'U-03', name: 'Stanford StartX', region: 'US', url: 'https://startx.com/companies', category: 'university_incubator' },
  { id: 'U-05', name: 'UC Berkeley SkyDeck', region: 'US', url: 'https://skydeck.berkeley.edu/companies/', category: 'university_incubator' },
  { id: 'U-07', name: 'CMU Swartz Center', region: 'US', url: 'https://www.cmu.edu/swartz-center-for-entrepreneurship/', category: 'university_incubator' },
  { id: 'U-12', name: 'Waterloo Velocity', region: 'Canada', url: 'https://velocity.uwaterloo.ca/companies/', category: 'university_incubator' },
  { id: 'U-17', name: 'ETH Transfer', region: 'Switzerland', url: 'https://ethz.ch/en/industry/transfer.html', category: 'university_incubator' },
  { id: 'U-18', name: 'Technion T3', region: 'Israel', url: 'https://t3.technion.ac.il/', category: 'university_incubator' },
  { id: 'U-21', name: 'CSIRO ON Accelerator', region: 'Australia', url: 'https://oninnovation.com.au/en/On-Accelerator', category: 'university_incubator' },

  { id: 'A-01', name: 'Y Combinator Companies', region: 'US', url: 'https://www.ycombinator.com/companies', category: 'accelerator' },
  { id: 'A-02', name: 'Alchemist Accelerator', region: 'US', url: 'https://alchemistaccelerator.com/portfolio', category: 'accelerator' },
  { id: 'A-03', name: 'Plug and Play Supply Chain', region: 'US', url: 'https://www.plugandplaytechcenter.com/supply-chain/', category: 'accelerator' },
  { id: 'A-06', name: 'Thrive AgTech', region: 'US', url: 'https://www.svgventures.com/companies', category: 'accelerator' },
  { id: 'A-11', name: 'MassChallenge', region: 'US', url: 'https://masschallenge.org/startups', category: 'accelerator' },
  { id: 'A-13', name: 'SOSV HAX', region: 'US/HK', url: 'https://hax.co/portfolio/', category: 'accelerator' },
  { id: 'A-17', name: 'Antler', region: 'Global', url: 'https://www.antler.vc/portfolio', category: 'accelerator' },
  { id: 'A-30', name: 'Creative Destruction Lab', region: 'Canada', url: 'https://creativedestructionlab.com/companies/', category: 'accelerator' },

  { id: 'V-01', name: 'a16z Portfolio', region: 'US', url: 'https://a16z.com/portfolio', category: 'vc_portfolio' },
  { id: 'V-02', name: 'Sequoia Portfolio', region: 'US', url: 'https://www.sequoiacap.com/companies/', category: 'vc_portfolio' },
  { id: 'V-03', name: 'Bessemer Portfolio', region: 'US', url: 'https://www.bvp.com/portfolio', category: 'vc_portfolio' },
  { id: 'V-04', name: 'Lux Capital Portfolio', region: 'US', url: 'https://luxcapital.com/companies', category: 'vc_portfolio' },
  { id: 'V-05', name: 'Breakthrough Energy', region: 'US', url: 'https://www.breakthroughenergy.org/', category: 'vc_portfolio' },
  { id: 'V-16', name: 'S2G Ventures Portfolio', region: 'US', url: 'https://s2gventures.com/portfolio', category: 'vc_portfolio' },
  { id: 'V-31', name: 'OurCrowd Portfolio', region: 'Israel', url: 'https://www.ourcrowd.com/portfolio/', category: 'vc_portfolio' },
  { id: 'V-35', name: 'Main Sequence Ventures', region: 'Australia', url: 'https://www.mseq.vc/portfolio', category: 'vc_portfolio' },

  { id: 'N-01', name: 'TechCrunch Funding RSS', region: 'Global', url: 'https://techcrunch.com/tag/funding/feed', category: 'news_rss' },
  { id: 'N-04', name: 'AgFunder News RSS', region: 'Global', url: 'https://agfundernews.com/feed', category: 'news_rss' },
  { id: 'N-06', name: 'FreightWaves RSS', region: 'US', url: 'https://www.freightwaves.com/news/feed', category: 'news_rss' },
  { id: 'N-07', name: 'Supply Chain Dive RSS', region: 'US', url: 'https://www.supplychaindive.com/feeds/news/', category: 'news_rss' },
  { id: 'N-10', name: 'Manufacturing Dive RSS', region: 'US', url: 'https://www.manufacturingdive.com/feeds/news/', category: 'news_rss' },
  { id: 'N-12', name: 'Robot Report RSS', region: 'Global', url: 'https://www.therobotreport.com/feed/', category: 'news_rss' },
  { id: 'N-16', name: 'Sifted RSS', region: 'EU', url: 'https://sifted.eu/feed', category: 'news_rss' },
  { id: 'N-23', name: 'BetaKit RSS', region: 'Canada', url: 'https://betakit.com/feed/', category: 'news_rss' },

  { id: 'D-01', name: 'YC Directory', region: 'US', url: 'https://www.ycombinator.com/companies', category: 'database' },
  { id: 'D-02', name: 'Wellfound Jobs', region: 'Global', url: 'https://wellfound.com/jobs', category: 'database' },
  { id: 'D-03', name: 'Crunchbase Public', region: 'Global', url: 'https://www.crunchbase.com/discover/organization.companies', category: 'database' },
  { id: 'D-05', name: 'BetaList', region: 'Global', url: 'https://betalist.com', category: 'database' },
  { id: 'D-11', name: 'F6S', region: 'Global', url: 'https://www.f6s.com/companies', category: 'database' },
  { id: 'D-14', name: 'Dealroom', region: 'EU', url: 'https://app.dealroom.co/companies', category: 'database' },
  { id: 'D-20', name: 'StartupBlink', region: 'Global', url: 'https://www.startupblink.com/startups', category: 'database' },

  { id: 'S-02', name: 'FreightTech 25', region: 'US', url: 'https://www.freightwaves.com/news/freighttech-100', category: 'industry_specialist' },
  { id: 'S-09', name: 'Spend Matters', region: 'US', url: 'https://spendmatters.com/feed/', category: 'industry_specialist' },
  { id: 'S-17', name: 'World Agri-Tech Summit', region: 'Global', url: 'https://worldagritechsummit.com/startups/', category: 'industry_specialist' },
  { id: 'S-22', name: 'DC Velocity', region: 'US', url: 'https://www.dcvelocity.com/rss', category: 'industry_specialist' },
  { id: 'S-24', name: 'Smart Industry', region: 'US', url: 'https://www.smartindustry.com/feed/', category: 'industry_specialist' },

  { id: 'C-02', name: 'LinkedIn Boolean Search', region: 'Global', url: 'https://linkedin.com', category: 'social_signal', requires_auth: true },
  { id: 'C-03', name: 'Reddit r/startups', region: 'Global', url: 'https://www.reddit.com/r/startups.json', category: 'social_signal' },
  { id: 'C-04', name: 'Reddit r/supplychain', region: 'Global', url: 'https://www.reddit.com/r/supplychain.json', category: 'social_signal' },
  { id: 'C-06', name: 'Reddit r/agtech', region: 'Global', url: 'https://www.reddit.com/r/agtech.json', category: 'social_signal' },
  { id: 'C-08', name: 'StrictlyVC Substack', region: 'US', url: 'https://strictlyvc.com/feed/', category: 'social_signal' },
];

function normalizeStage(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '_').replace('preseed', 'pre-seed');
}

function toHost(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const allowedRegions = new Set(['US', 'Canada', 'UK', 'EU', 'Israel', 'Australia', 'New Zealand', 'Global']);
const targetStages = new Set(['stealth', 'pre-seed', 'pre_seed', 'seed', 'series_a', 'series_b', 'series_c']);

const activeExpanded = data
  .filter((s) => allowedRegions.has(s.region))
  .filter((s) => (s.stage_bias || []).some((stage) => targetStages.has(normalizeStage(stage))))
  .map((s) => ({
    id: s.id,
    name: s.name,
    region: s.region,
    category: s.category,
    stage_bias: s.stage_bias,
    tier: s.cadence?.tier,
    frequency: s.cadence?.frequency,
    method_type: s.method?.type,
    url: s.method?.url,
    host: toHost(s.method?.url),
    adapter: s.adapter,
  }));

const output = {
  generated_at: new Date().toISOString(),
  strategy_version: 'v2.0-thesis',
  thesis: {
    primary: [
      'supply-chain', 'tms', 'wms', '3pl', 'manufacturing', 'agtech', 'industrial-ai',
      'procurement', 'inventory-planning', 'iiot', 'traceability', 'warehouse-robotics', 'd2c-fulfillment'
    ],
    stages: ['stealth', 'pre-seed', 'seed', 'series_a', 'series_b', 'series_c'],
    geographies: ['US', 'Canada', 'UK', 'EU', 'Israel', 'Australia', 'New Zealand'],
  },
  required_library_spec: {
    source: 'User v2.0 Expanded Source Library (176 + existing ~12 => 200+)',
    required_minimum_sources: 200,
    notes: 'This file keeps both MUST-HAVE targets from the thesis plan and active expanded registry coverage.'
  },
  must_have_targets: mustHaveSources,
  active_expanded_registry_sources: activeExpanded,
  summary: {
    must_have_count: mustHaveSources.length,
    active_expanded_count: activeExpanded.length,
    total_strategy_sources: mustHaveSources.length + activeExpanded.length,
  },
};

fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`Wrote ${outPath}`);
console.log(output.summary);
