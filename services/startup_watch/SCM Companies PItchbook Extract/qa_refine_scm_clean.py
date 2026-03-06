import csv
import re
from pathlib import Path
from datetime import datetime

BASE = Path('/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My Drive/MBA/VC/Resume & Applications/Startups to recommend/Bulk Data')
IN_CSV = BASE / 'SCM_Companies_List_clean.csv'
OUT_CSV = BASE / 'SCM_Companies_List_clean_final.csv'
OUT_HQ_CSV = BASE / 'SCM_Companies_List_clean_final_high_confidence.csv'
ISSUES_CSV = BASE / 'SCM_Companies_List_clean_issues.csv'
SUMMARY_TXT = BASE / 'SCM_Companies_List_clean_summary.txt'

WEB_RE = re.compile(r'\b[a-z0-9][a-z0-9\-]{1,}\.(com|io|co|ai|de|no|id|net|org|eu|tech|cloud|app|jp|fr|uk|us|be|nl|br|cn|ch|at|se|dk|fi|it|es|pl|mx|sg)\b', re.I)
HEADCOUNT_RE = re.compile(r'^\d{1,3}(?:,\d{3})?\s*[-–]\s*\d{1,3}(?:,\d{3})?$')
YEAR_RE = re.compile(r'^(19\d{2}|20\d{2})$')
MONEY_RE = re.compile(r'^\d+(?:\.\d+)?$')
DATE_RE = re.compile(r'^[A-Z][a-z]{2}\s+\d{1,2},\s*\d{4}\s+\d{1,2}\.\d{2}\s+[AP]M$')
NA_RE = re.compile(r'\b(nla|nja|nfa)\b', re.I)
BAD_SITE_LHS = {'food', 'retail', 'software', 'technology', 'corporate', 'sustainability', 'profile', 'company'}


def n(s):
    s = (s or '').strip()
    s = s.replace('\u2019', "'").replace('\u2013', '-').replace('\u2014', '-')
    s = re.sub(r'\s+', ' ', s)
    return s


def company_is_reasonable(name):
    if not name:
        return False
    if not re.match(r'^[A-Za-z0-9]', name):
        return False
    stripped = re.sub(r'[^A-Za-z0-9&+.,()\'" -]', '', name)
    if len(stripped) < 3:
        return False
    alpha = sum(ch.isalpha() for ch in stripped)
    bad = sum(1 for ch in name if not re.match(r'[A-Za-z0-9&+.,()\'" -]', ch))
    if bad > max(1, int(0.15 * len(name))):
        return False
    return alpha >= 2


def normalize_status(status):
    toks = [t.strip().lower() for t in status.split('|') if t.strip()]
    toks = [t for t in toks if t in {'save', 'hide', 'gave', 'show'}]
    if not toks:
        return ''
    uniq = []
    for t in toks:
        if t not in uniq:
            uniq.append(t)
    return ' | '.join(uniq)


def find_site(text):
    text = n(text).lower()
    m = WEB_RE.search(text)
    if m:
        d = m.group(0)
        lhs = d.split('.', 1)[0]
        if lhs not in BAD_SITE_LHS:
            return d
    m2 = re.search(r'\b([a-z0-9][a-z0-9\-]{2,})\s+(com|io|co|ai|de|no|id|net|org|eu|tech|cloud|app|jp|fr|uk|us|be|nl|br|cn|ch|at|se|dk|fi|it|es|pl|mx|sg)\b', text)
    if m2:
        lhs = m2.group(1)
        if lhs not in BAD_SITE_LHS:
            return f"{lhs}.{m2.group(2)}"
    return ''


def clean_desc(desc):
    desc = n(desc)
    desc = NA_RE.sub('', desc)
    desc = re.sub(r'\s+\|\s+', ' ', desc)
    desc = re.sub(r'\s+', ' ', desc).strip(' |,;')
    return desc


def to_float_or_blank(v):
    v = n(v)
    if not v:
        return ''
    if MONEY_RE.match(v):
        return v
    return ''


def is_date_like(v):
    return bool(DATE_RE.match(n(v)))


def normalize_added_date(v):
    v = n(v)
    v = v.replace(' .', '.').replace(' ,', ',')
    v = re.sub(r',(\d{4})', r', \1', v)
    v = re.sub(r'\s+', ' ', v)
    m = re.search(r'([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2})\.(\d{2})\s*([AP]M)', v)
    if m:
        mon, day, year, hh, mm, ap = m.groups()
        return f"{mon} {int(day)}, {year} {int(hh)}.{mm} {ap}"
    return v


rows = []
with IN_CSV.open(encoding='utf-8', newline='') as f:
    r = csv.DictReader(f)
    for rec in r:
        rows.append({k: n(v) for k, v in rec.items()})

issues = []
seen_keys = set()
final = []

def add_issue(company, field, issue_type, detail):
    issues.append({'company': company, 'field': field, 'issue_type': issue_type, 'detail': detail})

for rec in rows:
    company = rec.get('company', '')
    raw = rec.get('raw_row_text', '')

    rec['status'] = normalize_status(rec.get('status', ''))
    rec['added_date'] = normalize_added_date(rec.get('added_date', ''))
    rec['description'] = clean_desc(rec.get('description', ''))

    # website repair
    site = rec.get('website', '').lower()
    if site:
        repaired = find_site(site)
        if repaired:
            site = repaired
        else:
            site = ''
    if not site:
        site = find_site(raw)
    rec['website'] = site

    # numeric normalizations
    rec['founded'] = rec['founded'] if YEAR_RE.match(rec.get('founded', '')) else ''
    rec['total_funding_m'] = to_float_or_blank(rec.get('total_funding_m', ''))
    rec['last_funding_amount_m'] = to_float_or_blank(rec.get('last_funding_amount_m', ''))

    # correct swapped / impossible values
    if rec['founded'] and rec['total_funding_m'] == rec['founded']:
        rec['total_funding_m'] = ''

    # headcount
    if rec.get('headcount') and not HEADCOUNT_RE.match(rec['headcount']):
        add_issue(company, 'headcount', 'format', f"Unexpected headcount format: {rec['headcount']}")

    # date format
    if rec.get('added_date') and not is_date_like(rec['added_date']):
        add_issue(company, 'added_date', 'format', f"Unexpected date format: {rec['added_date']}")

    # required fields
    if not company:
        add_issue(company, 'company', 'missing', 'Missing company')
        continue
    if not company_is_reasonable(company):
        add_issue(company, 'company', 'format', 'Company name looks garbled')
    if not rec.get('added_date'):
        add_issue(company, 'added_date', 'missing', 'Missing added_date')

    # suspicious values
    if not rec.get('website'):
        add_issue(company, 'website', 'missing', 'No website extracted')
    if rec.get('founded') and int(rec['founded']) > datetime.now().year:
        add_issue(company, 'founded', 'range', f"Future year {rec['founded']}")
    if rec.get('total_funding_m') and rec.get('last_funding_amount_m'):
        try:
            if float(rec['last_funding_amount_m']) > float(rec['total_funding_m']):
                # Prefer preserving last funding amount and blanking inconsistent total.
                rec['total_funding_m'] = ''
                add_issue(company, 'funding', 'consistency', 'last_funding_amount_m > total_funding_m (blanked total)')
        except Exception:
            pass

    key = (company.lower(), rec.get('website', '').lower(), rec.get('added_date', '').lower())
    if key in seen_keys:
        add_issue(company, 'row', 'duplicate', 'Duplicate company+website+date removed')
        continue
    seen_keys.add(key)

    final.append(rec)

# sort for stable output
final.sort(key=lambda x: (x.get('company', '').lower(), x.get('added_date', '')))

field_order = [
    'company', 'added_date', 'status', 'description', 'website', 'headcount',
    'ownership_type', 'founded', 'total_funding_m', 'last_funding_amount_m',
    'last_funding_type', 'last_funding_lead_investor', 'company_address', 'growth_metrics',
    'source_page', 'source_row', 'raw_row_text'
]

with OUT_CSV.open('w', encoding='utf-8', newline='') as f:
    w = csv.DictWriter(f, fieldnames=field_order)
    w.writeheader()
    for rec in final:
        w.writerow({k: rec.get(k, '') for k in field_order})

# Build a high-confidence subset for immediate sourcing use.
issue_index = {}
for it in issues:
    comp = it['company'].lower()
    issue_index[comp] = issue_index.get(comp, 0) + 1

hq = []
for rec in final:
    c = rec.get('company', '')
    if not company_is_reasonable(c):
        continue
    if not is_date_like(rec.get('added_date', '')):
        continue
    if not rec.get('website'):
        continue
    if issue_index.get(c.lower(), 0) > 1:
        continue
    hq.append(rec)

with OUT_HQ_CSV.open('w', encoding='utf-8', newline='') as f:
    w = csv.DictWriter(f, fieldnames=field_order)
    w.writeheader()
    for rec in hq:
        w.writerow({k: rec.get(k, '') for k in field_order})

with ISSUES_CSV.open('w', encoding='utf-8', newline='') as f:
    w = csv.DictWriter(f, fieldnames=['company', 'field', 'issue_type', 'detail'])
    w.writeheader()
    for it in issues:
        w.writerow(it)

missing_website = sum(1 for r in final if not r.get('website'))
missing_founded = sum(1 for r in final if not r.get('founded'))
missing_total = sum(1 for r in final if not r.get('total_funding_m'))

summary = [
    f"input_rows={len(rows)}",
    f"final_rows={len(final)}",
    f"issues={len(issues)}",
    f"missing_website={missing_website}",
    f"missing_founded={missing_founded}",
    f"missing_total_funding_m={missing_total}",
    f"output={OUT_CSV}",
    f"high_confidence_output={OUT_HQ_CSV}",
    f"high_confidence_rows={len(hq)}",
    f"issues_file={ISSUES_CSV}",
]
SUMMARY_TXT.write_text('\n'.join(summary) + '\n', encoding='utf-8')

print('\n'.join(summary))
