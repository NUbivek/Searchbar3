#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
let OpenAI = null;
try { OpenAI = require('openai'); } catch {}

const SIGNALS_PATH = path.join(process.cwd(), 'data/signals.jsonl');

function isObviousJunk(name) {
  if (/^Visit\s+/i.test(name)) {
    name = name.replace(/^Visit\s+/i, '').trim();
  }
  if (!name || name.length < 2 || name.length > 80) return true;
  if (/—/.test(name)) return true;
  if (/^\+?[\d\s\-()\.]{7,}$/.test(name)) return true;
  if (/@/.test(name) || /^(info|admin|contact|hello|support|noreply|careers|jobs|team|press|media)([._-]?[a-z0-9_\-.]{3,})?$/i.test(name)) return true;
  if (/\b(icon|logo|image|img|svg|png|jpg|gif|webp|banner|thumbnail|avatar|badge|photo|picture|graphic)\b/i.test(name)) return true;
  if (/\b(opens external site|click here|see details|see domain|visit campus|directions)\b/i.test(name)) return true;
  if (/^(pre-seed|seed|series [abcd]|stealth|unknown|grant|angel|bridge|ipo|spac)\s*[\-—]?$/i.test(name.trim())) return true;
  if (/^(log\s*in|sign\s*(in|up)|register|login|logout|get started|apply now|learn more|read more|see more|view all|show more|load more|back|next|previous|contact us|about us|our team|meet the team|privacy policy|terms of service|cookie policy|all rights reserved|copyright|sitemap|subscribe|newsletter|follow us|share|home|about|portfolio|team|news|blog|press|careers|jobs|events|resources|insights|research|reports|case studies|white papers|webinars|podcasts|flagship program|faculty advisors|our accelerators|job board|open positions|open roles|work with us|investor relations|press kit|media kit|menu|navigation|header|footer|sidebar)$/i.test(name.trim())) return true;
  if (/\b(prizes?\s+for|award\s+for|grants?\s+for|morgenthaler|mcginnis|announces?\s+new|launches?\s+new|opens?\s+application)\b/i.test(name)) return true;
  if (/^(twitter|x\.com|linkedin|facebook|instagram|youtube|tiktok|reddit|github|substack|medium|notion|slack|zoom|discord|telegram|whatsapp|snapchat|pinterest)(\s+(icon|logo|link|page|handle|account|profile))?$/i.test(name.trim())) return true;
  const ALLOWED = /^(AI|ML|B2B|IOT|API|SAAS|ERP|WMS|TMS|YC|VC|LP|GP|SPV|AWS|GCP|UI|UX|SDK|MVP|KPI|ROI|CRM|SCM|NFT|DTC|D2C|ESG|IPO|R&D|HR|IT|CEO|CTO|CFO|COO)$/;
  if (/^[A-Z][A-Z\s]{4,}$/.test(name.trim()) && name.includes(' ') && !ALLOWED.test(name.trim())) return true;
  if (/\(acquired by|\bacquired by\b|merger with|merged with/i.test(name)) return true;
  if (/\b(health center|medical center|student center|care center|community center|visitor center|resource center|university library|university news|public library|city hall|school district|school board)\b/i.test(name)) return true;
  if (/^(supply chain integrations?|world positive report|general funding|energy transition|open lp|recent investments?|portfolio companies|our portfolio|meet our companies|all companies|featured companies|campus|visit campus|v2vc|wearefine|giving at illinois|security advisor|new creative tech activate|new scale up wellington|flagship program|faculty advisors|our accelerators|sell on etsy)$/i.test(name.trim())) return true;
  if (!/[a-zA-Z]{2,}/.test(name)) return true;
  return false;
}

function isBorderline(name) {
  if (name.length < 4) return true;
  if (/^\d+[a-z]/i.test(name)) return true;
  const words = name.split(/\s+/);
  if (words.length > 4 && words.filter((w) => /^[A-Z]/.test(w)).length > 3) return true;
  if (/^(explore|discover|find|get|learn|read|see|view|watch|download|access|request|schedule|book|join|connect|apply|submit|send|call|visit|click|tap|swipe|scroll|open|close|toggle|select|choose|filter|sort|search|reset|clear|export|import|upload|share|copy|paste|edit|delete|remove|add|create|update|save|cancel|confirm|continue|proceed|finish|complete|done|hire|recruit|fundraise|invest|partner|sponsor|donate|volunteer|mentor|advise|support|help|assist|enable)\b/i.test(name.trim())) return true;
  return false;
}

async function classifyNamesWithLLM(names) {
  if (!names.length) return new Set();
  if (!process.env.OPENAI_API_KEY || !OpenAI) {
    console.log('OPENAI_API_KEY not available; skipping LLM classification and using rules-only mode.');
    return new Set();
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const junk = new Set();
  const BATCH = 100;
  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    const prompt = `You are a startup data quality filter. For each name below, respond with ONLY "keep" or "drop".\n\nRules:\n- keep = a real startup or company name\n- drop = nav text, UI element, announcement, award name, generic phrase, institutional name, stage label, social icon, or anything clearly not a startup.\n\nNames:\n${batch.map((n, idx) => `${idx + 1}. ${n}`).join('\n')}\n\nRespond only with numbered lines like:\n1. keep\n2. drop`;
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: batch.length * 8,
    });
    const lines = String(response.choices?.[0]?.message?.content || '').trim().split('\n');
    for (let j = 0; j < batch.length; j += 1) {
      if ((lines[j] || '').toLowerCase().includes('drop')) junk.add(batch[j]);
    }
    process.stdout.write(`\r  LLM classified ${Math.min(i + BATCH, names.length)}/${names.length}...`);
  }
  console.log('');
  return junk;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const skipLLM = process.argv.includes('--rules-only');
  const signals = fs.readFileSync(SIGNALS_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const uniqueNames = [...new Set(signals.map((s) => s.company_name).filter(Boolean))];
  const ruleJunk = new Set();
  const borderline = new Set();
  uniqueNames.forEach((name) => {
    if (isObviousJunk(name)) ruleJunk.add(name);
    else if (!skipLLM && isBorderline(name)) borderline.add(name);
  });
  console.log(`Rule-based junk: ${ruleJunk.size}`);
  console.log(`Borderline (LLM needed): ${borderline.size}`);
  let llmJunk = new Set();
  if (!skipLLM && borderline.size) {
    if (dryRun) {
      console.log('DRY RUN: skipping LLM calls');
      console.log('Sample borderline names:');
      [...borderline].slice(0, 20).forEach((n) => console.log(`  "${n}"`));
    } else {
      llmJunk = await classifyNamesWithLLM([...borderline]);
    }
  }
  const allJunk = new Set([...ruleJunk, ...llmJunk]);
  console.log(`Total junk identified: ${allJunk.size}`);
  if (dryRun) {
    console.log('\nSample rule-junk (first 30):');
    [...ruleJunk].slice(0, 30).forEach((n) => console.log(`  DROP: "${n}"`));
    console.log('\nSample LLM-junk (first 10):');
    [...llmJunk].slice(0, 10).forEach((n) => console.log(`  DROP(LLM): "${n}"`));
    return;
  }
  let dropped = 0;
  const kept = [];
  const droppedSample = [];
  signals.forEach((sig) => {
    if (allJunk.has(sig.company_name)) {
      dropped += 1;
      if (droppedSample.length < 50) droppedSample.push(`"${sig.company_name}" | ${sig.source_id}`);
    } else {
      kept.push(JSON.stringify(sig));
    }
  });
  fs.writeFileSync(SIGNALS_PATH, kept.join('\n') + '\n');
  console.log(`\nDropped: ${dropped}, Remaining: ${kept.length}`);
  console.log('\nDropped sample:');
  droppedSample.forEach((s) => console.log(' ', s));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
