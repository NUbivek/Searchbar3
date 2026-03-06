import csv
import re
from pathlib import Path

BASE = Path('/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My Drive/MBA/VC/Resume & Applications/Startups to recommend/Bulk Data')
IN_ROWS = BASE / 'SCM_Companies_List_ocr_rows.csv'
OUT = BASE / 'SCM_Companies_List_structured_final.csv'
ISSUES = BASE / 'SCM_Companies_List_structured_issues.csv'

DATE_RE = re.compile(r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s*\d{4}\s+\d{1,2}\.\d{2}\s*[AP]M', re.I)
FULL_DATE_RE = re.compile(r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s*\d{4}', re.I)
WEB_RE = re.compile(r'\b[a-z0-9][a-z0-9\-]{1,}\.(?:com|io|co|ai|de|no|id|net|org|eu|tech|cloud|app|jp|fr|uk|us|be|nl|br|cn|ch|at|se|dk|fi|it|es|pl|mx|sg|me|nz|gg)\b', re.I)
SPACED_WEB_RE = re.compile(r'\b([a-z0-9][a-z0-9\-]{2,})\s+(com|io|co|ai|de|no|id|net|org|eu|tech|cloud|app|jp|fr|uk|us|be|nl|br|cn|ch|at|se|dk|fi|it|es|pl|mx|sg|me|nz|gg)\b', re.I)
HEADCOUNT_RE = re.compile(r'^\d{1,3}(?:,\d{3})?\s*[-–]\s*\d{1,3}(?:,\d{3})?$')
YEAR_RE = re.compile(r'^(19\d{2}|20\d{2})$')
NUM_RE = re.compile(r'^\d+(?:\.\d+)?$')
PCT_RE = re.compile(r'[-~]?\d+\s*%')

UI_WORDS = {'save', 'hide', 'gave', 'khide', '(hide', 'chide', 'gve', 'show'}
OWN_TYPES = {'venture capital', 'private equity', 'corporate', 'public', 'other financial'}
FUNDING_TYPES = {'series', 'seed', 'pre-seed', 'debt', 'grant', 'angel'}
BAD_WEB_LHS = {'food', 'retail', 'software', 'technology', 'corporate', 'profile', 'company', 'marketplace'}


def norm(s):
    s = (s or '').strip()
    s = s.replace('\u2019', "'").replace('\u2013', '-').replace('\u2014', '-')
    s = re.sub(r'\s+', ' ', s)
    return s


def clean_company(s):
    s = norm(s)
    s = re.sub(r'^[^A-Za-z0-9]+', '', s)
    s = re.sub(r'[^A-Za-z0-9&+.,()\'"/ -]+$', '', s)
    return s.strip(' |-')


def parse_tokens(row_text):
    toks = [norm(x) for x in row_text.split('|')]
    toks = [t for t in toks if t]
    return toks


def find_date_index(toks):
    for i, t in enumerate(toks):
        if DATE_RE.search(t):
            return i
    return None


def parse_website_token(tok):
    t = tok.lower()
    m = WEB_RE.search(t)
    if m:
        return m.group(0)
    m2 = SPACED_WEB_RE.search(t)
    if m2:
        return f"{m2.group(1)}.{m2.group(2)}"
    return ''


def normalize_date(s):
    s = norm(s)
    s = s.replace(' ,', ',').replace(' .', '.')
    s = re.sub(r',([0-9]{4})', r', \1', s)
    return s


def parse_row(row_text):
    toks = parse_tokens(row_text)
    low = [t.lower() for t in toks]

    if 'load contacts' not in ' | '.join(low):
        return None, ['no_load_contacts']

    d_idx = find_date_index(toks)
    if d_idx is None:
        return None, ['no_added_date']

    # company: nearest non-ui token before date
    j = d_idx - 1
    while j >= 0 and low[j] in UI_WORDS:
        j -= 1
    if j < 0:
        return None, ['no_company_before_date']

    company = clean_company(toks[j])
    added_date = normalize_date(toks[d_idx])

    # split blocks
    lc_idx = next((i for i, t in enumerate(low) if 'load contacts' in t), None)
    if lc_idx is None or lc_idx <= d_idx:
        return None, ['bad_load_contacts_anchor']

    left = toks[d_idx + 1:lc_idx]
    right = toks[lc_idx + 1:]

    # remove leading noise in left
    left = [x for x in left if x.lower() not in UI_WORDS]

    website = ''
    w_idx = None

    headcount = ''
    hc_idx = None
    for i, t in enumerate(left):
        if HEADCOUNT_RE.match(t):
            headcount = t
            hc_idx = i
            break

    # website candidates with scoring (prefer around headcount area, avoid generic lhs like food.tech)
    web_cands = []
    for i, t in enumerate(left):
        w = parse_website_token(t)
        if not w:
            continue
        lhs = w.split('.', 1)[0].lower()
        if lhs in BAD_WEB_LHS:
            continue
        score = 0
        if hc_idx is not None:
            score += abs(i - hc_idx)
        # strong preference for compact website-looking tokens
        if ' ' in t.strip():
            score += 2
        # prefer tokens that include company name stem
        cstem = re.sub(r'[^a-z0-9]', '', company.lower())[:8]
        if cstem and cstem in re.sub(r'[^a-z0-9]', '', w.lower()):
            score -= 2
        web_cands.append((score, i, w))
    if web_cands:
        web_cands.sort(key=lambda x: (x[0], x[1]))
        _, w_idx, website = web_cands[0]

    employees = ''
    if hc_idx is not None:
        for k in range(hc_idx + 1, min(hc_idx + 4, len(left))):
            x = left[k].replace(',', '')
            if x.isdigit() and 1 <= len(x) <= 5:
                employees = left[k]
                break

    # description = left tokens before website/headcount after removing company duplicate
    stop = len(left)
    if w_idx is not None:
        stop = min(stop, w_idx)
    if hc_idx is not None:
        stop = min(stop, hc_idx)
    desc_parts = []
    for t in left[:stop]:
        tl = t.lower()
        if tl in UI_WORDS:
            continue
        if t == company:
            continue
        desc_parts.append(t)
    description = norm(' '.join(desc_parts))
    if not description and left:
        fallback = [t for t in left if t != company and t != website and not HEADCOUNT_RE.match(t)]
        description = norm(' '.join(fallback[:8]))

    # location approx after headcount
    country = region = city = ''
    url_slug = ''
    if hc_idx is not None:
        loc = left[hc_idx + 1:]
        # remove employee count if first
        if loc and loc[0].replace(',', '').isdigit():
            loc = loc[1:]
        if loc:
            country = loc[0]
        if len(loc) > 1:
            region = loc[1]
        if len(loc) > 2:
            city = loc[2]
        if len(loc) > 3:
            url_slug = loc[3]

    # right block parsing
    right_clean = [x for x in right if x.lower() not in {'ntacts', 'contacts'}]
    ownership_type = ''
    founded = ''
    total_funding_m = ''
    last_funding_amount_m = ''
    last_funding_date = ''
    last_funding_type = ''
    last_funding_lead_investor = ''
    investor_type = ''
    investors = ''
    investment_count = ''

    for t in right_clean:
        tl = t.lower()
        if not ownership_type and tl in OWN_TYPES:
            ownership_type = t.title() if tl != 'other financial' else 'Other Financial'
        if not founded and YEAR_RE.match(t):
            founded = t

    nums = [t for t in right_clean if NUM_RE.match(t) and not YEAR_RE.match(t)]
    if nums:
        total_funding_m = nums[0]
    if len(nums) > 1:
        last_funding_amount_m = nums[1]

    # date in right block (last funding date)
    for t in right_clean:
        if FULL_DATE_RE.search(t):
            last_funding_date = norm(t)
            break
    if not last_funding_date:
        # month + year token style
        for i in range(len(right_clean) - 1):
            a, b = right_clean[i], right_clean[i + 1]
            if re.match(r'^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b', a, re.I) and YEAR_RE.match(b):
                last_funding_date = f"{a} {b}"
                break

    for i, t in enumerate(right_clean):
        tl = t.lower()
        if tl in FUNDING_TYPES:
            last_funding_type = 'Pre-Seed' if tl == 'pre-seed' else tl.title()
            if i + 1 < len(right_clean):
                last_funding_lead_investor = right_clean[i + 1]
            if i + 2 < len(right_clean):
                investor_type = right_clean[i + 2]
            if i + 3 < len(right_clean):
                investors = right_clean[i + 3]
            break

    # investment count heuristic: standalone int near right side
    for t in right_clean:
        x = t.replace(',', '')
        if x.isdigit() and 1 <= len(x) <= 3:
            investment_count = t

    # growth columns: assign sequentially from percent tokens
    pcts = []
    for t in right_clean:
        for m in PCT_RE.findall(t):
            m = norm(m)
            if m not in pcts:
                pcts.append(m)

    growth_cols = {
        'growth_3mo_headcount': pcts[0] if len(pcts) > 0 else '',
        'growth_6mo_headcount': pcts[1] if len(pcts) > 1 else '',
        'growth_1yr_headcount': pcts[2] if len(pcts) > 2 else '',
        'growth_2yr_headcount': pcts[3] if len(pcts) > 3 else '',
        'growth_3yr_headcount': pcts[4] if len(pcts) > 4 else '',
        'growth_4yr_headcount': pcts[5] if len(pcts) > 5 else '',
        'growth_5yr_headcount': pcts[6] if len(pcts) > 6 else '',
        'growth_3mo_web_traffic': pcts[7] if len(pcts) > 7 else '',
        'growth_extra_1': pcts[8] if len(pcts) > 8 else '',
        'growth_extra_2': pcts[9] if len(pcts) > 9 else '',
    }

    # address: longest token with semicolon/comma near end
    company_address = ''
    for t in reversed(right_clean):
        if ';' in t or ', ' in t:
            company_address = t
            break

    # quality flags
    flags = []
    if not company:
        flags.append('missing_company')
    if not added_date:
        flags.append('missing_added_date')
    if not website:
        flags.append('missing_website')
    if not description:
        flags.append('missing_description')
    if not last_funding_type:
        flags.append('missing_last_funding_type')

    out = {
        'company': company,
        'added_date': added_date,
        'description': description,
        'website': website,
        'headcount': headcount,
        'employees': employees,
        'country': country,
        'region': region,
        'city': city,
        'url_slug': url_slug,
        'ownership_type': ownership_type,
        'founded': founded,
        'total_funding_m': total_funding_m,
        'last_funding_amount_m': last_funding_amount_m,
        'last_funding_date': last_funding_date,
        'last_funding_type': last_funding_type,
        'last_funding_lead_investor': last_funding_lead_investor,
        'investor_type': investor_type,
        'investors': investors,
        'investment_count': investment_count,
        'company_address': company_address,
        **growth_cols,
    }

    return out, flags


def main():
    rows = []
    with IN_ROWS.open(encoding='utf-8', newline='') as f:
        rows = list(csv.DictReader(f))

    out_rows = []
    issues = []
    seen = set()

    for r in rows:
        text = r['row_text']
        if 'Status | Company | Added Date' in text:
            continue
        if 'Load contacts' not in text:
            continue

        parsed, flags = parse_row(text)
        if not parsed:
            issues.append({'company':'', 'source_page':r['page'], 'source_row':r['row_index'], 'issue':'parse_failed', 'detail':' | '.join(flags)})
            continue

        key = (parsed['company'].lower(), parsed['website'].lower(), parsed['added_date'])
        if key in seen:
            continue
        seen.add(key)

        parsed['source_page'] = r['page']
        parsed['source_row'] = r['row_index']
        parsed['qa_flags'] = ' | '.join(flags)
        parsed['qa_pass'] = 'yes' if not flags else 'no'

        out_rows.append(parsed)

        for fl in flags:
            issues.append({'company': parsed['company'], 'source_page': r['page'], 'source_row': r['row_index'], 'issue': fl, 'detail': ''})

    field_order = [
        'company','added_date','description','website','headcount','employees','country','region','city','url_slug',
        'ownership_type','founded','total_funding_m','last_funding_amount_m','last_funding_date','last_funding_type',
        'last_funding_lead_investor','investor_type','investors','investment_count','company_address',
        'growth_3mo_headcount','growth_6mo_headcount','growth_1yr_headcount','growth_2yr_headcount','growth_3yr_headcount',
        'growth_4yr_headcount','growth_5yr_headcount','growth_3mo_web_traffic','growth_extra_1','growth_extra_2',
        'source_page','source_row','qa_pass','qa_flags'
    ]

    with OUT.open('w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=field_order)
        w.writeheader()
        for row in out_rows:
            w.writerow({k: row.get(k, '') for k in field_order})

    with ISSUES.open('w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['company','source_page','source_row','issue','detail'])
        w.writeheader()
        w.writerows(issues)

    print('rows_out', len(out_rows))
    print('issues', len(issues))
    print('out', OUT)
    print('issues_file', ISSUES)


if __name__ == '__main__':
    main()
