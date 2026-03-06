import csv
import re
from pathlib import Path

BASE = Path('/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My Drive/MBA/VC/Resume & Applications/Startups to recommend/Bulk Data')
INP = BASE / 'SCM_Companies_List_full_company_rows.csv'
OUT = BASE / 'SCM_Companies_List_all_rows_clean_structured.csv'
REPORT = BASE / 'SCM_Companies_List_all_rows_clean_structured_report.txt'

DATE_TIME_RE = re.compile(r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s*\d{4}\s+\d{1,2}\.\d{2}\s*[AP]M', re.I)
DATE_RE = re.compile(r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s*\d{4}', re.I)
MONTH_RE = re.compile(r'^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b', re.I)
WEB_RE = re.compile(r'\b[a-z0-9][a-z0-9\-]{1,}\.(?:com|io|co|ai|de|no|id|net|org|eu|tech|cloud|app|jp|fr|uk|us|be|nl|br|cn|ch|at|se|dk|fi|it|es|pl|mx|sg|me|nz|gg)\b', re.I)
SP_WEB_RE = re.compile(r'\b([a-z0-9][a-z0-9\-]{2,})\s+(com|io|co|ai|de|no|id|net|org|eu|tech|cloud|app|jp|fr|uk|us|be|nl|br|cn|ch|at|se|dk|fi|it|es|pl|mx|sg|me|nz|gg)\b', re.I)
HEADCOUNT_RE = re.compile(r'^\d{1,3}(?:,\d{3})?\s*[-–]\s*\d{1,3}(?:,\d{3})?$')
NUM_RE = re.compile(r'^\d+(?:\.\d+)?$')
YEAR_RE = re.compile(r'^(19\d{2}|20\d{2})$')
PCT_RE = re.compile(r'[-~]?\d+\s*%')

UI_WORDS = {'save', 'hide', 'gave', 'show', 'khide', '(hide', 'chide', 'gve'}
OWN_TYPES = {'venture capital', 'private equity', 'corporate', 'public', 'other financial'}
FUND_TYPES = {'series', 'seed', 'pre-seed', 'debt', 'grant', 'angel'}
BAD_WEB_LHS = {'food', 'retail', 'software', 'technology', 'corporate', 'company', 'profile', 'marketplace'}


def n(s: str) -> str:
    s = (s or '').strip()
    s = s.replace('\u2019', "'").replace('\u2013', '-').replace('\u2014', '-')
    s = re.sub(r'\s+', ' ', s)
    return s


def clean_company(s: str) -> str:
    s = n(s)
    s = re.sub(r'^[^A-Za-z0-9]+', '', s)
    s = re.sub(r'[^A-Za-z0-9&+.,()\'"/ -]+$', '', s)
    return s.strip(' |-')


def parse_web(tok: str) -> str:
    t = n(tok).lower()
    m = WEB_RE.search(t)
    if m:
        d = m.group(0)
        if d.split('.', 1)[0] in BAD_WEB_LHS:
            return ''
        return d
    m2 = SP_WEB_RE.search(t)
    if m2:
        lhs = m2.group(1)
        if lhs in BAD_WEB_LHS:
            return ''
        return f'{lhs}.{m2.group(2)}'
    return ''


def normalize_dt(s: str) -> str:
    s = n(s)
    s = s.replace(' ,', ',').replace(' .', '.')
    s = re.sub(r',([0-9]{4})', r', \1', s)
    return s


def parse_row(row_id: int, source_page: str, source_row: str, row_text: str, fallback_company: str, fallback_date: str, fallback_web: str):
    toks = [n(x) for x in row_text.split('|') if n(x)]
    low = [t.lower() for t in toks]

    # locate date/time
    d_idx = None
    for i, t in enumerate(toks):
        if DATE_TIME_RE.search(t):
            d_idx = i
            break

    added_date = normalize_dt(toks[d_idx]) if d_idx is not None else normalize_dt(fallback_date)

    # locate company (before date)
    company = ''
    if d_idx is not None:
        j = d_idx - 1
        while j >= 0 and low[j] in UI_WORDS:
            j -= 1
        if j >= 0:
            company = clean_company(toks[j])
    if not company:
        company = clean_company(fallback_company)

    lc_idx = next((i for i, t in enumerate(low) if 'load contacts' in t), None)

    # split around date/load contacts when possible
    left = []
    right = []
    if d_idx is not None and lc_idx is not None and lc_idx > d_idx:
        left = toks[d_idx + 1:lc_idx]
        right = toks[lc_idx + 1:]
    else:
        # fallback split: use whole row as left
        left = toks[:]
        right = []

    left = [x for x in left if x.lower() not in UI_WORDS]
    right = [x for x in right if x.lower() not in {'ntacts', 'contacts'}]

    # website candidate
    website = ''
    w_idx = None
    web_cands = []
    for i, t in enumerate(left):
        w = parse_web(t)
        if w:
            web_cands.append((i, w))
    if web_cands:
        # pick earliest plausible website token in data segment
        w_idx, website = web_cands[0]
    if not website:
        website = parse_web(fallback_web) or fallback_web.lower()

    # headcount and employees
    headcount = ''
    hc_idx = None
    for i, t in enumerate(left):
        if HEADCOUNT_RE.match(t):
            headcount = t
            hc_idx = i
            break

    employees = ''
    if hc_idx is not None:
        for k in range(hc_idx + 1, min(hc_idx + 4, len(left))):
            x = left[k].replace(',', '')
            if x.isdigit() and 1 <= len(x) <= 5:
                employees = left[k]
                break

    # description: tokens from left before website/headcount
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
    description = n(' '.join(desc_parts))

    if not description:
        # soft fallback
        fallback_parts = [t for t in left if t != company and t != website and not HEADCOUNT_RE.match(t)]
        description = n(' '.join(fallback_parts[:8]))

    # location fields after headcount
    country = region = city = url_slug = ''
    if hc_idx is not None:
        loc = left[hc_idx + 1:]
        if loc and loc[0].replace(',', '').isdigit():
            loc = loc[1:]
        if len(loc) > 0:
            country = loc[0]
        if len(loc) > 1:
            region = loc[1]
        if len(loc) > 2:
            city = loc[2]
        if len(loc) > 3:
            url_slug = loc[3]

    # right-side fields
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

    for t in right:
        tl = t.lower()
        if not ownership_type and tl in OWN_TYPES:
            ownership_type = 'Other Financial' if tl == 'other financial' else t.title()
        if not founded and YEAR_RE.match(t):
            founded = t

    nums = [t for t in right if NUM_RE.match(t) and not YEAR_RE.match(t)]
    if nums:
        total_funding_m = nums[0]
    if len(nums) > 1:
        last_funding_amount_m = nums[1]

    # date: prefer full date in right
    for t in right:
        if DATE_RE.search(t):
            last_funding_date = n(t)
            break
    if not last_funding_date:
        for i in range(len(right) - 1):
            if MONTH_RE.match(right[i]) and YEAR_RE.match(right[i + 1]):
                last_funding_date = f"{right[i]} {right[i+1]}"
                break

    for i, t in enumerate(right):
        tl = t.lower()
        if tl in FUND_TYPES:
            last_funding_type = 'Pre-Seed' if tl == 'pre-seed' else tl.title()
            if i + 1 < len(right):
                last_funding_lead_investor = right[i + 1]
            if i + 2 < len(right):
                investor_type = right[i + 2]
            if i + 3 < len(right):
                investors = right[i + 3]
            break

    for t in right:
        x = t.replace(',', '')
        if x.isdigit() and 1 <= len(x) <= 3:
            investment_count = t

    # growth metrics split
    pcts = []
    for t in right:
        for m in PCT_RE.findall(t):
            m = n(m)
            if m not in pcts:
                pcts.append(m)

    growth = {
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

    # address heuristic
    company_address = ''
    for t in reversed(right):
        if ';' in t or ', ' in t:
            company_address = t
            break

    # quality notes (do not drop rows)
    qa_flags = []
    if not company:
        qa_flags.append('missing_company')
    if not added_date:
        qa_flags.append('missing_added_date')
    if not website:
        qa_flags.append('missing_website')
    if not description:
        qa_flags.append('missing_description')
    if not last_funding_type:
        qa_flags.append('missing_last_funding_type')

    out = {
        'row_id': row_id,
        'source_page': source_page,
        'source_row': source_row,
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
        **growth,
        'qa_flags': ' ; '.join(qa_flags),
        'qa_pass': 'yes' if not qa_flags else 'no',
    }

    # ensure no pipe separators remain
    for k, v in list(out.items()):
        if isinstance(v, str):
            out[k] = v.replace('|', ' ').strip()

    return out


def main():
    with INP.open(encoding='utf-8', newline='') as f:
        src = list(csv.DictReader(f))

    rows = []
    for idx, rec in enumerate(src, start=1):
        parsed = parse_row(
            row_id=idx,
            source_page=rec.get('source_page', ''),
            source_row=rec.get('source_row', ''),
            row_text=rec.get('row_text', ''),
            fallback_company=rec.get('company', ''),
            fallback_date=rec.get('added_date', ''),
            fallback_web=rec.get('website', ''),
        )
        rows.append(parsed)

    fields = [
        'row_id','source_page','source_row','company','added_date','description','website','headcount','employees',
        'country','region','city','url_slug','ownership_type','founded','total_funding_m','last_funding_amount_m',
        'last_funding_date','last_funding_type','last_funding_lead_investor','investor_type','investors','investment_count',
        'company_address','growth_3mo_headcount','growth_6mo_headcount','growth_1yr_headcount','growth_2yr_headcount',
        'growth_3yr_headcount','growth_4yr_headcount','growth_5yr_headcount','growth_3mo_web_traffic',
        'growth_extra_1','growth_extra_2','qa_pass','qa_flags'
    ]

    with OUT.open('w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)

    # report
    missing_company = sum(1 for r in rows if not r['company'])
    missing_date = sum(1 for r in rows if not r['added_date'])
    missing_web = sum(1 for r in rows if not r['website'])
    missing_lft = sum(1 for r in rows if not r['last_funding_type'])
    qa_pass = sum(1 for r in rows if r['qa_pass'] == 'yes')
    pipe_cells = sum(1 for r in rows for v in r.values() if isinstance(v, str) and '|' in v)

    report_lines = [
        f'input_rows={len(src)}',
        f'output_rows={len(rows)}',
        f'qa_pass_rows={qa_pass}',
        f'qa_fail_rows={len(rows) - qa_pass}',
        f'missing_company={missing_company}',
        f'missing_added_date={missing_date}',
        f'missing_website={missing_web}',
        f'missing_last_funding_type={missing_lft}',
        f'pipe_cells={pipe_cells}',
        f'output_file={OUT}',
    ]
    REPORT.write_text('\n'.join(report_lines) + '\n', encoding='utf-8')
    print('\n'.join(report_lines))


if __name__ == '__main__':
    main()
