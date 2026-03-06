import csv
import re
from pathlib import Path

BASE = Path('/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My Drive/MBA/VC/Resume & Applications/Startups to recommend/Bulk Data')
ROWS = BASE / 'SCM_Companies_List_ocr_rows.csv'
OUT = BASE / 'SCM_Companies_List_clean.csv'

DATE_RE = re.compile(r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}[,\.]\s*\d{4}', re.I)
DOMAIN_RE = re.compile(r'\b[a-z0-9][a-z0-9\-]{1,}\.(?:com|io|co|ai|de|no|id|net|org|eu|tech|cloud|app)\b', re.I)
HEADCOUNT_RE = re.compile(r'\b\d{1,3}\s*[-–]\s*\d{1,3}(?:,\d{3})?\b')
YEAR_RE = re.compile(r'\b(19\d{2}|20\d{2})\b')
PERCENT_RE = re.compile(r'[-~]?\d+\s*%')
ACTION = {'save', 'hide', 'gave', 'show'}


def norm(t):
    t = t.strip().replace('\u2019', "'")
    t = re.sub(r'\s+', ' ', t)
    return t


def find_domain(token):
    t = token.lower().strip()
    m = DOMAIN_RE.search(t)
    if m:
        return m.group(0)
    t2 = re.sub(r'\s+', ' ', t)
    m2 = re.search(r'\b([a-z0-9][a-z0-9\-]{2,})\s+(com|io|co|ai|de|no|id|net|org|eu|tech|cloud|app)\b', t2)
    if m2:
        lhs = m2.group(1)
        if lhs in {'food', 'retail', 'software', 'technology', 'corporate', 'sustainability'}:
            return ''
        return f"{lhs}.{m2.group(2)}"
    return ''


def parse_row_text(row_text):
    toks = [norm(x) for x in row_text.split('|')]
    toks = [t for t in toks if t]
    low = [t.lower() for t in toks]

    if 'load contacts' not in ' | '.join(low):
        return None
    if 'status' in low or 'company' in low:
        return None

    d_idx = next((i for i, t in enumerate(toks) if DATE_RE.search(t)), None)
    lc_idx = next((i for i, t in enumerate(low) if 'load contacts' in t), None)
    if d_idx is None or lc_idx is None or lc_idx <= d_idx:
        return None

    # Company is nearest token before date that is not action noise
    company = ''
    j = d_idx - 1
    while j >= 0 and toks[j].lower() in ACTION:
        j -= 1
    if j >= 0:
        company = toks[j]

    status_tokens = [t for t in toks[:max(j, 0)] if t.lower() in ACTION]
    status = ' | '.join(status_tokens)

    added_date = toks[d_idx]
    left = toks[d_idx + 1:lc_idx]
    right = toks[lc_idx + 1:]

    website = ''
    for t in left:
        m = find_domain(t)
        if m:
            website = m
            break

    headcount = next((t for t in left if HEADCOUNT_RE.search(t)), '')
    description_parts = []
    for t in left:
        if t in {company, website, headcount}:
            continue
        if DATE_RE.search(t):
            continue
        description_parts.append(t)
    description = ' '.join(description_parts).strip()

    ownership_type = next((t for t in right if t.lower() in {'venture capital', 'private equity', 'corporate'}), '')
    founded = next((t for t in right if YEAR_RE.fullmatch(t)), '')

    nums = [
        t for t in right
        if re.fullmatch(r'\d+(?:\.\d+)?', t)
        and not YEAR_RE.fullmatch(t)
    ]
    total_funding_m = nums[0] if nums else ''
    last_funding_amount_m = nums[1] if len(nums) > 1 else ''

    last_funding_type = next((t for t in right if t.lower() in {'series', 'seed', 'pre-seed', 'debt', 'grant'}), '')
    lead_investor = ''
    if last_funding_type and last_funding_type in right:
        i = right.index(last_funding_type)
        if i + 1 < len(right):
            lead_investor = right[i + 1]

    addr = ''
    for t in reversed(right):
        if ';' in t or ', ' in t:
            addr = t
            break

    growth = ' | '.join([t for t in right if PERCENT_RE.search(t)])

    return {
        'status': status,
        'company': company,
        'added_date': added_date,
        'description': description,
        'website': website,
        'headcount': headcount,
        'ownership_type': ownership_type,
        'founded': founded,
        'total_funding_m': total_funding_m,
        'last_funding_amount_m': last_funding_amount_m,
        'last_funding_type': last_funding_type,
        'last_funding_lead_investor': lead_investor,
        'company_address': addr,
        'growth_metrics': growth,
        'raw_row_text': ' | '.join(toks),
    }

rows = []
with ROWS.open(encoding='utf-8', newline='') as f:
    r = csv.DictReader(f)
    for rec in r:
        parsed = parse_row_text(rec['row_text'])
        if not parsed:
            continue
        parsed['page'] = rec['page']
        parsed['row_index'] = rec['row_index']
        rows.append(parsed)

# Deduplicate repeated rows from repeated OCR pages by company+date+website+description hash
uniq = []
seen = set()
for r in rows:
    key = (
        r['company'].lower(),
        r['added_date'].lower(),
        r['website'].lower(),
        re.sub(r'\W+', '', r['description'].lower())[:120],
    )
    if key in seen:
        continue
    seen.add(key)
    uniq.append(r)

# Remove obvious garbage rows with missing company/date
clean = [r for r in uniq if r['company'] and r['added_date']]

with OUT.open('w', encoding='utf-8', newline='') as f:
    w = csv.writer(f)
    w.writerow([
        'company', 'added_date', 'status', 'description', 'website', 'headcount',
        'ownership_type', 'founded', 'total_funding_m', 'last_funding_amount_m',
        'last_funding_type', 'last_funding_lead_investor', 'company_address', 'growth_metrics',
        'source_page', 'source_row', 'raw_row_text'
    ])
    for r in clean:
        w.writerow([
            r['company'], r['added_date'], r['status'], r['description'], r['website'], r['headcount'],
            r['ownership_type'], r['founded'], r['total_funding_m'], r['last_funding_amount_m'],
            r['last_funding_type'], r['last_funding_lead_investor'], r['company_address'], r['growth_metrics'],
            r['page'], r['row_index'], r['raw_row_text']
        ])

print('parsed rows:', len(rows))
print('deduped rows:', len(uniq))
print('clean rows:', len(clean))
print('out:', OUT)
