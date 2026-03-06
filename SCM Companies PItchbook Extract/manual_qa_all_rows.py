import csv
import re
from pathlib import Path

BASE = Path('/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My Drive/MBA/VC/Resume & Applications/Startups to recommend/Bulk Data')
IN_CSV = BASE / 'SCM_Companies_List_clean_final_high_confidence.csv'
OUT_CSV = BASE / 'SCM_Companies_List_manual_qa_all_rows.csv'
LOG_CSV = BASE / 'SCM_Companies_List_manual_qa_changes.csv'

WEB_RE = re.compile(r'^[a-z0-9][a-z0-9\-]*\.(com|io|co|ai|de|no|id|net|org|eu|tech|cloud|app|jp|fr|uk|us|be|nl|br|cn|ch|at|se|dk|fi|it|es|pl|mx|sg)$', re.I)
DATE_RE = re.compile(r'^([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2})\.(\d{2})\s*([AP]M)$')
HC_RE = re.compile(r'^\d{1,3}(?:,\d{3})?\s*[-–]\s*\d{1,3}(?:,\d{3})?$')
YEAR_RE = re.compile(r'^(19\d{2}|20\d{2})$')
NA_RE = re.compile(r'\b(nla|nja|nfa|n/a|nia|nil|none)\b', re.I)
PCT_FIND_RE = re.compile(r'[-~]?\d+\s*%')

ACTIONS = {'save', 'hide', 'gave', 'show'}
OWN_MAP = {
    'venture capital': 'Venture Capital',
    'private equity': 'Private Equity',
    'corporate': 'Corporate',
    'public': 'Public',
}
FUNDING_TYPES = {'series', 'seed', 'pre-seed', 'debt', 'grant'}


def n(s):
    s = (s or '').strip()
    s = s.replace('\u2019', "'").replace('\u2013', '-').replace('\u2014', '-')
    s = re.sub(r'\s+', ' ', s)
    return s


def clean_company(s):
    s = n(s)
    s = re.sub(r'^[^A-Za-z0-9]+', '', s)
    s = re.sub(r'[^A-Za-z0-9&+.,()\'"/ -]+$', '', s)
    s = s.strip(' |-')
    return s


def clean_date(s):
    s = n(s)
    s = s.replace(' ,', ',').replace(' .', '.')
    s = re.sub(r',([0-9]{4})', r', \1', s)
    m = DATE_RE.match(s)
    if not m:
        return s
    mon, d, y, h, mm, ap = m.groups()
    return f"{mon} {int(d)}, {y} {int(h)}.{mm} {ap}"


def clean_status(s):
    toks = [n(x).lower() for x in s.split('|') if n(x)]
    toks = [t for t in toks if t in ACTIONS]
    seen = []
    for t in toks:
        if t not in seen:
            seen.append(t)
    return ' | '.join(seen)


def find_domains(text):
    t = n(text).lower()
    exact = re.findall(r'\b[a-z0-9][a-z0-9\-]{1,}\.(?:com|io|co|ai|de|no|id|net|org|eu|tech|cloud|app|jp|fr|uk|us|be|nl|br|cn|ch|at|se|dk|fi|it|es|pl|mx|sg)\b', t)
    out = []
    for d in exact:
        if d not in out:
            out.append(d)
    spaced = re.findall(r'\b([a-z0-9][a-z0-9\-]{2,})\s+(com|io|co|ai|de|no|id|net|org|eu|tech|cloud|app|jp|fr|uk|us|be|nl|br|cn|ch|at|se|dk|fi|it|es|pl|mx|sg)\b', t)
    for lhs, tld in spaced:
        d = f"{lhs}.{tld}"
        if d not in out:
            out.append(d)
    return out


def pick_website(current, raw):
    c = n(current).lower()
    if c and WEB_RE.match(c):
        return c
    bad_lhs = {'software', 'technology', 'corporate', 'company', 'profile', 'retail', 'food'}
    for d in find_domains(raw):
        if d.split('.', 1)[0] not in bad_lhs:
            return d
    return ''


def clean_desc(desc, company, website, raw):
    d = n(desc)
    d = NA_RE.sub('', d)
    if company:
        d = re.sub(r'^' + re.escape(company) + r'\s*', '', d, flags=re.I)
    if website:
        d = re.sub(re.escape(website), '', d, flags=re.I)
    d = re.sub(r'\s+', ' ', d).strip(' |,;')

    if len(d) < 20:
        toks = [n(x) for x in raw.split('|') if n(x)]
        low = [x.lower() for x in toks]
        lc = next((i for i, x in enumerate(low) if 'load contacts' in x), None)
        if lc is not None:
            left = toks[:lc]
            parts = []
            for t in left:
                tl = t.lower()
                if DATE_RE.match(clean_date(t)):
                    continue
                if t == company:
                    continue
                if website and website in tl:
                    continue
                if HC_RE.match(t):
                    continue
                if tl in ACTIONS:
                    continue
                if re.fullmatch(r'\d+', t):
                    continue
                parts.append(t)
            if parts:
                d = ' '.join(parts)
                d = re.sub(r'\s+', ' ', d).strip(' |,;')
    return d


def clean_growth(g):
    vals = PCT_FIND_RE.findall(n(g))
    out = []
    for v in vals:
        v = n(v)
        if v not in out:
            out.append(v)
    return ' | '.join(out)


def clean_num(x):
    x = n(x)
    return x if re.fullmatch(r'\d+(?:\.\d+)?', x) else ''


def flags_for(r):
    f = []
    if not r['company']:
        f.append('missing_company')
    if not DATE_RE.match(r['added_date']):
        f.append('bad_date')
    if not WEB_RE.match(r['website']):
        f.append('bad_website')
    if r['headcount'] and not HC_RE.match(r['headcount']):
        f.append('bad_headcount')
    if r['founded'] and not YEAR_RE.match(r['founded']):
        f.append('bad_founded')
    return f


with IN_CSV.open(encoding='utf-8', newline='') as f:
    rows = list(csv.DictReader(f))

out_rows = []
changes = []
seen = set()

for row in rows:
    orig = {k: n(v) for k, v in row.items()}
    r = dict(orig)

    r['company'] = clean_company(r.get('company', ''))
    r['added_date'] = clean_date(r.get('added_date', ''))
    r['status'] = clean_status(r.get('status', ''))
    r['website'] = pick_website(r.get('website', ''), r.get('raw_row_text', ''))
    r['description'] = clean_desc(r.get('description', ''), r['company'], r['website'], r.get('raw_row_text', ''))
    r['headcount'] = n(r.get('headcount', '')) if HC_RE.match(n(r.get('headcount', ''))) else ''

    own = n(r.get('ownership_type', '')).lower()
    r['ownership_type'] = OWN_MAP.get(own, '')

    founded = n(r.get('founded', ''))
    r['founded'] = founded if YEAR_RE.match(founded) else ''

    ft = n(r.get('last_funding_type', '')).lower()
    r['last_funding_type'] = ('Pre-Seed' if ft == 'pre-seed' else ft.title()) if ft in FUNDING_TYPES else ''

    r['total_funding_m'] = clean_num(r.get('total_funding_m', ''))
    r['last_funding_amount_m'] = clean_num(r.get('last_funding_amount_m', ''))

    if r['total_funding_m'] and r['last_funding_amount_m']:
        try:
            if float(r['last_funding_amount_m']) > float(r['total_funding_m']):
                r['total_funding_m'] = ''
        except Exception:
            r['total_funding_m'] = ''
            r['last_funding_amount_m'] = ''

    r['company_address'] = NA_RE.sub('', n(r.get('company_address', ''))).strip(' |,;')
    r['growth_metrics'] = clean_growth(r.get('growth_metrics', ''))

    key = (r['company'].lower(), r['website'].lower(), r['added_date'])
    if key in seen:
        continue
    seen.add(key)

    ff = flags_for(r)
    r['qa_flags'] = ' | '.join(ff)
    r['qa_pass'] = 'yes' if not ff else 'no'

    for k, v in r.items():
        if k in orig and v != orig[k]:
            changes.append({'company': r.get('company', ''), 'field': k, 'before': orig.get(k, ''), 'after': v})

    out_rows.append(r)

field_order = [
    'company', 'added_date', 'website', 'status', 'description', 'headcount', 'ownership_type', 'founded',
    'total_funding_m', 'last_funding_amount_m', 'last_funding_type', 'last_funding_lead_investor',
    'company_address', 'growth_metrics', 'source_page', 'source_row', 'qa_pass', 'qa_flags', 'raw_row_text'
]

with OUT_CSV.open('w', encoding='utf-8', newline='') as f:
    w = csv.DictWriter(f, fieldnames=field_order)
    w.writeheader()
    for r in out_rows:
        w.writerow({k: r.get(k, '') for k in field_order})

with LOG_CSV.open('w', encoding='utf-8', newline='') as f:
    w = csv.DictWriter(f, fieldnames=['company', 'field', 'before', 'after'])
    w.writeheader()
    w.writerows(changes)

pass_count = sum(1 for r in out_rows if r.get('qa_pass') == 'yes')
print('input_rows', len(rows))
print('output_rows', len(out_rows))
print('qa_pass_rows', pass_count)
print('qa_fail_rows', len(out_rows) - pass_count)
print('changes', len(changes))
print('out', OUT_CSV)
print('log', LOG_CSV)
