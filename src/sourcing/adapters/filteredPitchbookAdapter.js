const XLSX = require('xlsx');
const crypto = require('crypto');
const path = require('path');
const { BaseAdapter } = require('./baseAdapter');
const { classifySector } = require('../normalizer');

const SHEET_MAPS = {
  'Pitchbook SCM Clean Raw': {
    company_name: 'company', company_website: 'website', description: 'description', headcount: 'headcount', employees: 'employees',
    country: 'country', region: 'region', city: 'city', founded: 'founded', total_funding_m: 'total_funding_m',
    last_funding_amount_m: 'last_funding_amount_m', last_funding_date: 'last_funding_date', last_funding_type: 'last_funding_type',
    last_funding_lead_investor: 'last_funding_lead_investor', investors: 'investors', ownership_type: 'ownership_type',
    growth_1yr_headcount: 'growth_1yr_headcount', growth_3mo_web_traffic: 'growth_3mo_web_traffic', source_priority: 1,
  },
  'Pitchbook SCM Raw': {
    company_name: 'company', company_website: 'website', description: 'description', headcount: 'headcount', employees: 'employees',
    country: 'country', region: 'region', city: 'city', founded: 'founded', total_funding_m: 'total_funding_m',
    last_funding_amount_m: 'last_funding_amount_m', last_funding_date: 'last_funding_date', last_funding_type: 'last_funding_type',
    last_funding_lead_investor: 'last_funding_lead_investor', investors: 'investors', ownership_type: 'ownership_type',
    growth_1yr_headcount: 'growth_1yr_headcount', growth_3mo_web_traffic: 'growth_3mo_web_traffic', qa_pass: 'qa_pass', qa_flags: 'qa_flags', source_priority: 2,
  },
  "Brett's Format": {
    company_name: 'Company', description: 'Description', stage: 'Stage', funding_text: 'Funding or other details', theme: 'Theme',
    industry: 'Industry', value_chain: ' Value Chain Anchor', fit: 'Fit', source_priority: 3,
  },
  V_0: {
    company_name: 'Company', description: 'Description', stage: 'Stage', themes: 'Themes', fit: 'Fit', funding_text: 'Funding or other details', source_priority: 4,
  },
  'Venture5 SCM Deals': {
    company_name: 'Company Name', description: 'Description', funding_amount: 'Amount', stage: 'Round/Stage', deal_type: 'Deal Type', industry: 'Industry', date: 'Date', source_priority: 5,
  },
  'Venture5 Raw': {
    company_name: 'Company Name', description: 'Description', funding_amount: 'Amount', stage: 'Round/Stage', deal_type: 'Deal Type', industry: 'Industry', date: 'Date', source_priority: 6,
  },
  'Raw Extracts': {
    company_name: 'Name of the company', description: 'Description', specific_industry: 'Specific Industry Category', broader_industry: 'Broader Industry Category',
    country: 'Country', location1: 'Location 1', location2: 'Location 2', linkedin_url: 'LinkedIn Company Page', category: 'Category', source_priority: 7,
  },
  Manifest2026: {
    company_name: 0, source_priority: 8,
  },
};

const STAGE_MAP = {
  'pre-seed': 'Pre-Seed', 'pre seed': 'Pre-Seed', 'pre-series a': 'Pre-Seed', seed: 'Seed', 'early-stage': 'Seed', 'early stage': 'Seed',
  'series a': 'Series A', 'series b': 'Series B', 'series c': 'Series C', 'series d': 'Series D+', 'series e': 'Series D+', 'series f': 'Series D+',
  'series g': 'Series D+', series: 'Unknown', growth: 'Series D+', stealth: 'Stealth', 'n/a': null, other: null,
};

function normalizeCompanyName(raw) {
  if (!raw) return '';
  let name = String(raw).trim();
  if (name.match(/^https?:\/\//)) {
    name = name.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    name = name.split('/')[0].replace(/\.\w+$/, '');
  }
  return name;
}

function normalizeKey(name) {
  return normalizeCompanyName(name).toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function normalizeStage(raw) {
  if (!raw) return null;
  const lower = String(raw).trim().toLowerCase();
  return STAGE_MAP[lower] || (lower.includes('series') ? 'unknown_series' : null);
}

function parseFundingAmount(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  if (str.toLowerCase() === 'not disclosed' || str === 'N/A') return null;
  const match = str.match(/\$?([\d.]+)\s*[Mm]/);
  if (match) return parseFloat(match[1]);
  const num = parseFloat(str);
  return Number.isNaN(num) ? null : num;
}

function extractRegion(row) {
  const country = row.country || row.location1 || '';
  const region = row.region || row.location2 || '';
  const city = row.city || '';
  const combined = [country, region, city].join(' ').toLowerCase();
  if (combined.match(/\b(us|usa|united states|california|new york|texas|boston|sf|nyc)\b/)) return 'US';
  if (combined.match(/\b(canada|toronto|vancouver|montreal|waterloo)\b/)) return 'Canada';
  if (combined.match(/\b(uk|united kingdom|london|england|scotland)\b/)) return 'UK';
  if (combined.match(/\b(israel|tel aviv|jerusalem|haifa)\b/)) return 'Israel';
  if (combined.match(/\b(australia|sydney|melbourne|brisbane)\b/)) return 'Australia';
  if (combined.match(/\b(new zealand|auckland|wellington)\b/)) return 'New Zealand';
  if (combined.match(/\b(germany|france|netherlands|spain|italy|sweden|finland|norway|denmark|switzerland|austria|belgium|ireland|eu|europe)\b/)) return 'EU';
  return country || 'Unknown';
}

function extractThesisTags(merged) {
  const tags = [];
  const text = [merged.description, merged.theme, merged.themes, merged.industry, merged.specific_industry, merged.broader_industry, merged.value_chain]
    .filter(Boolean).join(' ').toLowerCase();
  const tagMap = {
    'supply.chain': 'supply-chain', logistics: 'supply-chain', freight: 'supply-chain', 'tms|transport': 'tms',
    'wms|warehouse.management': 'wms', '3pl|third.party.logistics': '3pl', manufactur: 'manufacturing', 'agtech|agri': 'agtech',
    procure: 'procurement', inventory: 'inventory-planning', 'iiot|industrial.iot': 'iiot', 'traceab|track.trace': 'traceability',
    'warehouse.robot|amr|agv': 'warehouse-robotics', 'fulfillment|d2c': 'd2c-fulfillment', robot: 'robotics', automat: 'automation',
  };
  for (const [pattern, tag] of Object.entries(tagMap)) {
    if (new RegExp(pattern, 'i').test(text)) tags.push(tag);
  }
  return [...new Set(tags)];
}

function computeConfidence(merged) {
  let score = 0;
  if (merged.description) score += 0.2;
  if (merged.company_website) score += 0.15;
  if (merged.total_funding_m || merged.funding_amount || merged.funding_text) score += 0.2;
  if (merged.stage || merged.last_funding_type) score += 0.15;
  if (merged.country || merged.region) score += 0.1;
  if (merged.founded) score += 0.1;
  if (merged.investors || merged.last_funding_lead_investor) score += 0.1;
  return Math.round(score * 100) / 100;
}

function buildSignal(merged, sheetOrigins) {
  const signalId = `fpb-${crypto.createHash('md5').update(normalizeKey(merged.company_name)).digest('hex').slice(0, 12)}`;
  const website = merged.company_website || '';
  const domain = website ? website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '') : '';
  const thesisTags = extractThesisTags(merged);
  const classification = classifySector({
    company_name: normalizeCompanyName(merged.company_name),
    description: merged.description || '',
    source_name: 'Filtered Pitchbook',
    thesis_tags: thesisTags,
    industry: merged.industry || merged.specific_industry || merged.broader_industry,
    category: merged.category,
  });
  return {
    signal_id: signalId,
    company_name: normalizeCompanyName(merged.company_name),
    company_website: website,
    company_domain: domain,
    description: merged.description || '',
    stage: normalizeStage(merged.stage || merged.last_funding_type) || null,
    stage_guess: normalizeStage(merged.stage || merged.last_funding_type) || 'unknown',
    thesis_tags: thesisTags,
    sector_class: classification.sector,
    sector_name: classification.sector_name || 'Thesis-aligned',
    region: extractRegion(merged),
    region_guess: extractRegion(merged),
    signal_type: 'uploaded_dataset',
    source_id: 'UPL-FPB-001',
    source_name: 'Filtered Pitchbook',
    signal_weight: 'high',
    source_url: '',
    item_url: merged.linkedin_url || website || '',
    published_at: merged.last_funding_date || merged.date || null,
    discovered_at: new Date().toISOString(),
    evidence: `Uploaded from ${sheetOrigins.join(', ')}`,
    evidence_role: 'primary',
    confidence: computeConfidence(merged),
    score_components: {},
    enrichment: {
      funding_total_m: merged.total_funding_m || parseFundingAmount(merged.funding_amount || merged.funding_text) || null,
      last_round_m: merged.last_funding_amount_m || null,
      last_round_type: merged.last_funding_type || null,
      lead_investor: merged.last_funding_lead_investor || null,
      investors: merged.investors || null,
      headcount: merged.headcount || merged.employees || null,
      founded: merged.founded || null,
      growth_1yr: merged.growth_1yr_headcount || null,
      ownership: merged.ownership_type || null,
      fit_assessment: merged.fit || null,
      themes: merged.theme || merged.themes || null,
      value_chain: merged.value_chain || null,
    },
  };
}

async function ingestFilteredPitchbook(xlsxPath) {
  const workbook = XLSX.readFile(xlsxPath);
  const companyMap = {};
  for (const sheetName of Object.keys(SHEET_MAPS)) {
    if (!workbook.SheetNames.includes(sheetName)) {
      console.warn(`Sheet "${sheetName}" not found, skipping`);
      continue;
    }
    const mapping = SHEET_MAPS[sheetName];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
    console.log(`Reading ${sheetName}: ${rows.length} rows`);
    for (const row of rows) {
      let companyNameRaw;
      if (sheetName === 'Manifest2026') {
        companyNameRaw = Object.values(row)[0];
      } else {
        companyNameRaw = row[mapping.company_name];
      }
      if (!companyNameRaw || !String(companyNameRaw).trim()) continue;
      const key = normalizeKey(String(companyNameRaw));
      if (!key || key.length < 2) continue;
      const mapped = {};
      for (const [targetField, sourceCol] of Object.entries(mapping)) {
        if (targetField === 'source_priority') continue;
        if (typeof sourceCol === 'number') continue;
        const val = row[sourceCol];
        if (val !== null && val !== undefined && String(val).trim()) mapped[targetField] = String(val).trim();
      }
      mapped.company_name = companyNameRaw;
      if (!companyMap[key]) {
        companyMap[key] = { fields: mapped, priority: mapping.source_priority, sheets: [sheetName] };
      } else {
        companyMap[key].sheets.push(sheetName);
        if (mapping.source_priority < companyMap[key].priority) {
          const existing = companyMap[key].fields;
          companyMap[key].fields = mapped;
          companyMap[key].priority = mapping.source_priority;
          for (const [k, v] of Object.entries(existing)) {
            if (!companyMap[key].fields[k]) companyMap[key].fields[k] = v;
          }
        } else {
          for (const [k, v] of Object.entries(mapped)) {
            if (!companyMap[key].fields[k]) companyMap[key].fields[k] = v;
          }
        }
      }
    }
  }
  console.log(`\nInternal dedup: ${Object.keys(companyMap).length} unique companies from ${Object.values(companyMap).reduce((s, c) => s + c.sheets.length, 0)} raw rows`);
  return Object.values(companyMap).map((entry) => buildSignal(entry.fields, [...new Set(entry.sheets)]));
}

class FilteredPitchbookAdapter extends BaseAdapter {
  async run() {
    const configuredPath = this.source.method?.file || this.source.source_file || this.source.primary_url;
    if (!configuredPath) {
      throw new Error('FilteredPitchbookAdapter requires a file path');
    }
    const resolvedPath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.join(process.cwd(), configuredPath);
    const signals = await ingestFilteredPitchbook(resolvedPath);
    return { signals };
  }
}

module.exports = { FilteredPitchbookAdapter, ingestFilteredPitchbook, normalizeKey };
