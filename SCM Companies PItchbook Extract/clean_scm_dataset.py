import csv
import math
import re
from pathlib import Path

import cv2
import easyocr
import fitz

PDF_PATH = Path('/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My Drive/MBA/MY VC FUND/GFC Deals/Leads/SCM Companies List.pdf')
BASE = Path('/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My Drive/MBA/VC/Resume & Applications/Startups to recommend/Bulk Data')
MODEL_DIR = BASE / '.easyocr-model'
RAW_CSV = BASE / 'SCM_Companies_List_ocr_raw.csv'
ROWS_CSV = BASE / 'SCM_Companies_List_ocr_rows.csv'
CLEAN_CSV = BASE / 'SCM_Companies_List_clean.csv'

DATE_RE = re.compile(r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}[,\.]\s*\d{4}', re.I)
HEADCOUNT_RE = re.compile(r'\b\d{1,3}\s*[-–]\s*\d{1,3}(?:,\d{3})?\b')
DOMAIN_RE = re.compile(r'\b[a-z0-9][a-z0-9\-]{1,}\.(?:com|io|co|ai|de|no|id|net|org|eu|tech|cloud|app)\b', re.I)
YEAR_RE = re.compile(r'\b(19\d{2}|20\d{2})\b')
PERCENT_RE = re.compile(r'[-~]?\d+\s*%')
MONEY_RE = re.compile(r'\b\d+(?:\.\d+)?\b')

ACTION_WORDS = {
    'save', 'saved', 'hide', 'gave', 'show', 'send', 'sendoso',
}

KNOWN_COUNTRIES = {
    'norway', 'netherlands', 'united states', 'usa', 'france', 'israel', 'belgium', 'germany',
    'china', 'united kingdom', 'uk', 'brazil', 'indonesia', 'poland', 'mexico', 'austria',
    'switzerland', 'sweden', 'denmark', 'finland', 'italy', 'spain', 'canada', 'australia',
    'singapore', 'india', 'japan', 'south korea', 'ireland', 'portugal', 'czechia', 'czech republic',
}


def normalize_token(t):
    t = t.strip()
    t = t.replace('\u2019', "'").replace('\u2013', '-').replace('\u2014', '-')
    t = re.sub(r'\s+', ' ', t)
    return t


def pick_page_image_xref(page):
    info = page.get_image_info(xrefs=True)
    if not info:
        return None
    # use the image actually painted on this page (largest bbox if multiple)
    best = max(info, key=lambda x: (x.get('bbox', (0, 0, 0, 0))[2] - x.get('bbox', (0, 0, 0, 0))[0]) * (x.get('bbox', (0, 0, 0, 0))[3] - x.get('bbox', (0, 0, 0, 0))[1]))
    return best.get('xref')


def iou(a, b):
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    iw, ih = max(0, ix1 - ix0), max(0, iy1 - iy0)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    ua = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - inter
    return inter / ua if ua else 0.0


def dedupe_items(items):
    kept = []
    for it in sorted(items, key=lambda t: (-t[5], t[1], t[0])):
        x0, y0, x1, y1, txt, conf = it
        txtn = normalize_token(txt).lower()
        if not txtn:
            continue
        dup = False
        for k in kept:
            if txtn == normalize_token(k[4]).lower() and iou((x0, y0, x1, y1), (k[0], k[1], k[2], k[3])) > 0.45:
                dup = True
                break
        if not dup:
            kept.append((x0, y0, x1, y1, normalize_token(txt), conf))
    return sorted(kept, key=lambda t: (t[1], t[0]))


def cluster_rows(items, y_tol=18):
    rows = []
    for it in items:
        x0, y0, x1, y1, text, conf = it
        yc = (y0 + y1) / 2
        placed = None
        best = 999999
        for i, row in enumerate(rows):
            d = abs(yc - row['yc'])
            if d <= y_tol and d < best:
                placed = i
                best = d
        if placed is None:
            rows.append({'yc': yc, 'items': [it], 'n': 1})
        else:
            row = rows[placed]
            row['items'].append(it)
            row['yc'] = (row['yc'] * row['n'] + yc) / (row['n'] + 1)
            row['n'] += 1

    out = []
    for idx, row in enumerate(sorted(rows, key=lambda r: r['yc']), start=1):
        parts = sorted(row['items'], key=lambda t: t[0])
        tokens = [normalize_token(p[4]) for p in parts if normalize_token(p[4])]
        out.append((idx, row['yc'], tokens, parts))
    return out


def ocr_page(reader, img, page_no):
    H, W = img.shape[:2]
    rows, cols = 3, 3
    overlap = 0.08
    th = math.ceil(H / rows)
    tw = math.ceil(W / cols)
    out = []
    for r in range(rows):
        for c in range(cols):
            y0 = max(0, int(r * th - overlap * th))
            y1 = min(H, int((r + 1) * th + overlap * th))
            x0 = max(0, int(c * tw - overlap * tw))
            x1 = min(W, int((c + 1) * tw + overlap * tw))
            tile = img[y0:y1, x0:x1]
            res = reader.readtext(tile, detail=1, paragraph=False, mag_ratio=1.5, text_threshold=0.5, low_text=0.3)
            for box, text, conf in res:
                xs = [pt[0] + x0 for pt in box]
                ys = [pt[1] + y0 for pt in box]
                out.append((min(xs), min(ys), max(xs), max(ys), text, float(conf)))
    return dedupe_items(out)


def looks_like_company_row(tokens):
    s = ' | '.join(tokens).lower()
    if 'load contacts' not in s:
        return False
    if 'status' in s and 'added date' in s:
        return False
    return True


def parse_company_row(tokens):
    # Remove obviously empty/noisy tokens
    toks = [t for t in tokens if t and t not in {'|', ','}]
    low = [t.lower() for t in toks]

    # Date token position anchor
    d_idx = next((i for i, t in enumerate(toks) if DATE_RE.search(t)), None)

    # Company name: token before date, skipping action-like tokens
    company = ''
    status_tokens = []
    if d_idx is not None:
        j = d_idx - 1
        while j >= 0 and (toks[j].lower() in ACTION_WORDS or toks[j] in {'hide', 'save', 'gave'}):
            status_tokens.append(toks[j])
            j -= 1
        if j >= 0:
            company = toks[j]
            status_tokens = toks[:j]
        else:
            status_tokens = toks[:d_idx]
    else:
        # fallback
        company = toks[0] if toks else ''

    status = ' | '.join([t for t in status_tokens if t.lower() in {'save', 'hide', 'gave'}])

    added_date = toks[d_idx] if d_idx is not None else ''

    # split around Load contacts anchor
    lc_idx = next((i for i, t in enumerate(low) if 'load contacts' in t), None)

    left_block = toks[d_idx + 1:lc_idx] if d_idx is not None and lc_idx is not None and lc_idx > d_idx else []
    right_block = toks[lc_idx + 1:] if lc_idx is not None else []

    # Website from left block
    website = ''
    for t in left_block:
        if DOMAIN_RE.search(t):
            website = DOMAIN_RE.search(t).group(0)
            break

    # Headcount / employees / location from left block
    headcount = next((t for t in left_block if HEADCOUNT_RE.search(t)), '')
    employees = ''
    if headcount:
        try:
            hc_i = left_block.index(headcount)
            for k in range(hc_i + 1, min(hc_i + 4, len(left_block))):
                if re.fullmatch(r'\d{2,4}', left_block[k].replace(',', '')):
                    employees = left_block[k]
                    break
        except ValueError:
            pass

    country = ''
    region = ''
    city = ''
    if headcount:
        try:
            hc_i = left_block.index(headcount)
            loc = left_block[hc_i + 1:hc_i + 6]
            # choose first known country and next two as region/city
            for i, t in enumerate(loc):
                tl = t.lower()
                if tl in KNOWN_COUNTRIES:
                    country = t
                    if i + 1 < len(loc):
                        region = loc[i + 1]
                    if i + 2 < len(loc):
                        city = loc[i + 2]
                    break
        except ValueError:
            pass

    # Description from left block excluding mechanical fields
    desc_candidates = []
    for t in left_block:
        if t == company or t == website or t == headcount or t == employees:
            continue
        if t in {country, region, city}:
            continue
        if DATE_RE.search(t):
            continue
        if t.lower() in ACTION_WORDS:
            continue
        desc_candidates.append(t)
    description = ' '.join(desc_candidates).strip()

    ownership_type = ''
    founded = ''
    total_funding_m = ''
    last_funding_amount_m = ''
    last_funding_date = ''
    last_funding_type = ''
    last_lead_investor = ''
    investor_type = ''
    investors = ''
    company_address = ''

    # Parse right block in order; this is best-effort but usually stable near contacts
    rb = right_block[:]
    # ownership
    for i, t in enumerate(rb):
        tl = t.lower()
        if 'venture capital' in tl or 'private equity' in tl or 'corporate' in tl:
            ownership_type = t
            break

    # founded
    for t in rb:
        if YEAR_RE.fullmatch(t):
            founded = t
            break

    # numeric funding tokens
    nums = [t for t in rb if MONEY_RE.fullmatch(t)]
    if nums:
        total_funding_m = nums[0]
    if len(nums) > 1:
        last_funding_amount_m = nums[1]

    # last funding date
    for i, t in enumerate(rb):
        if DATE_RE.search(t):
            last_funding_date = t
            # maybe split month and year tokens around this area
            break
    if not last_funding_date:
        for i in range(len(rb) - 1):
            a, b = rb[i], rb[i + 1]
            if re.match(r'^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b', a, re.I) and YEAR_RE.search(b):
                last_funding_date = f'{a} {b}'
                break

    # funding type and investors
    for t in rb:
        if t.lower() in {'series', 'seed', 'pre-seed', 'debt', 'grant'}:
            last_funding_type = t
            break

    # investor type and lead investor heuristics
    if last_funding_type and last_funding_type in rb:
        idx = rb.index(last_funding_type)
        if idx + 1 < len(rb):
            last_lead_investor = rb[idx + 1]
        if idx + 2 < len(rb):
            investor_type = rb[idx + 2]
        if idx + 3 < len(rb):
            investors = rb[idx + 3]

    # address tends to be long semicolon-separated token near end
    for t in reversed(rb):
        if ';' in t or ', ' in t:
            company_address = t
            break

    growth_metrics = ' | '.join([t for t in rb if PERCENT_RE.search(t)])

    return {
        'status': status,
        'company': company,
        'added_date': added_date,
        'description': description,
        'website': website,
        'headcount': headcount,
        'employees': employees,
        'country': country,
        'region': region,
        'city': city,
        'ownership_type': ownership_type,
        'founded': founded,
        'total_funding_m': total_funding_m,
        'last_funding_amount_m': last_funding_amount_m,
        'last_funding_date': last_funding_date,
        'last_funding_type': last_funding_type,
        'last_lead_investor': last_lead_investor,
        'investor_type': investor_type,
        'investors': investors,
        'company_address': company_address,
        'growth_metrics': growth_metrics,
        'raw_row_text': ' | '.join(toks),
    }


def main():
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    reader = easyocr.Reader(['en'], gpu=False, verbose=False, model_storage_directory=str(MODEL_DIR), user_network_directory=str(MODEL_DIR))

    doc = fitz.open(str(PDF_PATH))

    raw_out = []
    row_out = []
    clean_out = []

    for page_no, page in enumerate(doc, start=1):
        xref = pick_page_image_xref(page)
        if not xref:
            continue
        img_data = doc.extract_image(xref)['image']
        tmp = Path(f'/tmp/scm_real_page_{page_no}.jpg')
        tmp.write_bytes(img_data)
        img = cv2.imread(str(tmp))
        if img is None:
            continue

        items = ocr_page(reader, img, page_no)
        rows = cluster_rows(items, y_tol=18)

        for x0, y0, x1, y1, txt, conf in items:
            raw_out.append([page_no, txt, conf, x0, y0, x1, y1])

        for row_idx, yc, tokens, parts in rows:
            row_text = ' | '.join(tokens)
            row_out.append([page_no, row_idx, yc, len(tokens), row_text])

            if looks_like_company_row(tokens):
                parsed = parse_company_row(tokens)
                clean_out.append([
                    page_no, row_idx,
                    parsed['status'], parsed['company'], parsed['added_date'],
                    parsed['description'], parsed['website'], parsed['headcount'], parsed['employees'],
                    parsed['country'], parsed['region'], parsed['city'],
                    parsed['ownership_type'], parsed['founded'], parsed['total_funding_m'], parsed['last_funding_amount_m'],
                    parsed['last_funding_date'], parsed['last_funding_type'], parsed['last_lead_investor'], parsed['investor_type'], parsed['investors'],
                    parsed['company_address'], parsed['growth_metrics'], parsed['raw_row_text'],
                ])

    with RAW_CSV.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['page', 'text', 'confidence', 'x0', 'y0', 'x1', 'y1'])
        w.writerows(raw_out)

    with ROWS_CSV.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['page', 'row_index', 'y_center', 'token_count', 'row_text'])
        w.writerows(row_out)

    with CLEAN_CSV.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow([
            'page', 'row_index', 'status', 'company', 'added_date',
            'description', 'website', 'headcount', 'employees',
            'country', 'region', 'city',
            'ownership_type', 'founded', 'total_funding_m', 'last_funding_amount_m',
            'last_funding_date', 'last_funding_type', 'last_funding_lead_investor', 'investor_type', 'investors',
            'company_address', 'growth_metrics', 'raw_row_text'
        ])
        w.writerows(clean_out)

    print('Wrote:', RAW_CSV)
    print('Wrote:', ROWS_CSV)
    print('Wrote:', CLEAN_CSV)
    print('raw entries:', len(raw_out))
    print('row entries:', len(row_out))
    print('clean company rows:', len(clean_out))


if __name__ == '__main__':
    main()
