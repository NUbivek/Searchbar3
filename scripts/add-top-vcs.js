#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(process.cwd(), 'sources', 'registry.json');
const THESIS_TAGS = ['supply_chain', 'manufacturing', 'industrial_ai', 'agtech', 'procurement'];

const URL_MAP = {
  'Sequoia Capital': 'https://www.sequoiacap.com/companies/',
  'Bessemer Venture Partners': 'https://www.bvp.com/portfolio',
  'Khosla Ventures': 'https://www.khoslaventures.com/portfolio/',
  'Lightspeed Venture Partners': 'https://lsvp.com/portfolio/',
  Benchmark: 'https://benchmark.com/portfolio/',
  IVP: 'https://www.ivp.com/portfolio/',
  NEA: 'https://www.nea.com/portfolio/',
  'Battery Ventures': 'https://www.battery.com/portfolio/',
  'General Catalyst': 'https://www.generalcatalyst.com/portfolio/',
  Greylock: 'https://greylock.com/portfolio/',
  'Insight Partners': 'https://www.insightpartners.com/portfolio/',
  'Founders Fund': 'https://foundersfund.com/portfolio/',
  Accel: 'https://www.accel.com/companies/',
  'GV (Google Ventures)': 'https://www.gv.com/portfolio/',
  'Index Ventures': 'https://www.indexventures.com/portfolio/',
  'Kleiner Perkins': 'https://www.kleinerperkins.com/portfolio/',
  'Craft Ventures': 'https://www.craftventures.com/portfolio/',
  'Emergence Capital': 'https://www.emcap.com/portfolio/',
  'Lux Capital': 'https://luxcapital.com/companies/',
  'Scale Venture Partners': 'https://www.scalevp.com/portfolio/',
  TCV: 'https://www.tcv.com/portfolio/',
  'Norwest Venture Partners': 'https://www.nvp.com/companies/',
  'Madrona Venture Group': 'https://madrona.com/portfolio/',
  'Energy Impact Partners': 'https://www.energyimpactpartners.com/portfolio/',
  'Trucks VC': 'https://www.trucksvc.com/portfolio/',
  'Wireframe Ventures': 'https://www.wireframevc.com/portfolio/',
  'Warburg Pincus': 'https://www.warburgpincus.com/portfolio/',
  'Vista Equity Partners': 'https://www.vistaequitypartners.com/portfolio/',
  'Francisco Partners': 'https://www.franciscopartners.com/portfolio/',
  'Apax Partners': 'https://www.apax.com/portfolio/',
  'KKR Growth': 'https://www.kkr.com/businesses/growth-equity/portfolio',
  'Blackstone Growth': 'https://www.blackstone.com/our-businesses/growth-equity/',
  'MCJ Collective': 'https://www.mcj.vc/portfolio',
  'Tough Tech': 'https://www.toughtech.vc/portfolio',
  'MHS Capital': 'https://www.mhscapital.com/portfolio',
  'Quiet Capital': 'https://quiet.com/portfolio',
  'Initialized Capital': 'https://initialized.com/portfolio',
  'Uncork Capital': 'https://www.uncork.com/portfolio/',
  'Felicis Ventures': 'https://www.felicis.com/portfolio/',
  'Work-Bench': 'https://www.work-bench.com/portfolio',
  'Moderne Ventures': 'https://www.moderneventures.com/portfolio',
  'Fifth Wall': 'https://fifthwall.com/portfolio',
  'Agility Capital': 'https://www.agilitycapital.com/portfolio',
  'Coatue Management': 'https://www.coatue.com/portfolio',
  'Greenoaks Capital': 'https://www.greenoaks.com/portfolio',
  'Social Capital': 'https://www.socialcapital.com/portfolio',
  'Menlo Ventures': 'https://menlovc.com/companies/',
  'Redpoint Ventures': 'https://www.redpoint.com/portfolio/',
  'Canaan Partners': 'https://www.canaan.com/portfolio/',
  Mayfield: 'https://www.mayfield.com/companies/',
  'Bling Capital': 'https://www.blingcapital.com/portfolio/',
  SignalFire: 'https://signalfire.com/portfolio/',
  'Amplify Partners': 'https://www.amplifypartners.com/portfolio/',
  'First Round Capital': 'https://firstround.com/review/companies/',
  'Ribbit Capital': 'https://www.ribbit.com/portfolio/',
  'Pillar VC': 'https://pillar.vc/portfolio/',
  'Primary Venture Partners': 'https://primary.vc/portfolio/',
  AlleyCorp: 'https://www.alleycorp.com/portfolio/',
  'Human Capital': 'https://humancapital.com/portfolio/',
  'Afore Capital': 'https://www.afore.vc/portfolio/',
  NFX: 'https://www.nfx.com/portfolio/',
  'Wing Venture Capital': 'https://wing.vc/portfolio/',
  'Pear VC': 'https://pear.vc/portfolio/',
  'Basis Set Ventures': 'https://www.basisset.com/portfolio/',
  Floodgate: 'https://floodgate.com/portfolio/',
  'GingerBread Capital': 'https://www.gingerbreadcap.com/portfolio/',
  'Blackhorn Ventures': 'https://www.blackhorn.vc/portfolio/',
  'Counterpart Ventures': 'https://counterpartventures.com/portfolio/',
  'Sway Ventures': 'https://www.swayvc.com/portfolio',
  'Slow Ventures': 'https://slow.co/portfolio',
  'Zetta Venture Partners': 'https://www.zettavp.com/portfolio',
  'Motive Ventures': 'https://www.motiveventures.com/portfolio',
  'E14 Fund': 'https://www.e14fund.com/companies',
  'Soma Capital': 'https://www.somacap.com/portfolio',
  'OMERS Ventures': 'https://www.omersventures.com/portfolio',
  'Mouro Capital': 'https://www.mourocapital.com/portfolio',
  'Foundry Group': 'https://foundry.vc/portfolio/',
  DCVC: 'https://www.dcvc.com/portfolio/',
  M12: 'https://m12.vc/portfolio/',
};

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function makeId(name, index) {
  const slug = slugify(name).replace(/-/g, '_').toUpperCase();
  return `VP_ADD_${String(index + 1).padStart(3, '0')}_${slug}`.slice(0, 28);
}

function buildEntry(name, url, index) {
  return {
    id: makeId(name, index),
    name,
    region: 'US',
    category: 'venture_portfolio',
    thesis_tags: THESIS_TAGS,
    stage_bias: ['seed', 'series_a', 'series_b', 'series_c'],
    method: { type: 'html', url },
    cadence: { tier: 'A', frequency: 'weekly' },
    query_strategy: { type: 'list_page' },
    requires_auth: false,
    adapter: 'html_list',
    notes: 'Added by add-top-vcs.js for thesis-aligned US VC expansion.',
    disabled: false,
    update_cadence: 'weekly',
    cron_expression: '0 6 * * 1',
    schedule_type: 'rolling_cadence',
    incremental_strategy: 'delta_by_domain',
    dedup_key: 'company_domain',
    signal_type: 'portfolio_page_scrape',
    staleness_threshold_days: 7,
    url,
    evidence_role: 'primary',
    signal_weight: 'high',
    review_rule: 'dedupe on company name+domain; require thesis fit for adjacent/generalist',
    fetch_notes: 'Added by add-top-vcs.js — top US VC expansion',
    source_file: 'codex_top_vc_expansion',
    workbook_adapter: 'html_list',
    workbook_method: 'html',
  };
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: node scripts/add-top-vcs.js "Sequoia Capital" "Bessemer Venture Partners" ...');
    process.exit(1);
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const existingNames = new Set(registry.map((entry) => String(entry.name || '').toLowerCase()));
  const additions = [];

  args.forEach((name, index) => {
    const url = URL_MAP[name];
    if (!url) {
      console.log(`SKIP (no curated URL): ${name}`);
      return;
    }
    if (existingNames.has(name.toLowerCase())) {
      console.log(`SKIP (already present): ${name}`);
      return;
    }
    const entry = buildEntry(name, url, index);
    additions.push(entry);
    existingNames.add(name.toLowerCase());
    console.log(`ADD: ${name} -> ${url}`);
  });

  if (!additions.length) {
    console.log('No new VC entries added.');
    return;
  }

  registry.push(...additions);
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
  console.log(`Added ${additions.length} new VCs to registry`);
  console.log(`Registry now has ${registry.length} total sources`);
}

main();
