import csv
from pathlib import Path
import fitz
import cv2
import easyocr

PDF_PATH = Path('/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My Drive/MBA/MY VC FUND/GFC Deals/Leads/SCM Companies List.pdf')
OUT_RAW = Path('/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My Drive/MBA/VC/Resume & Applications/Startups to recommend/Bulk Data/SCM_Companies_List_ocr_raw.csv')
OUT_ROWS = Path('/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My Drive/MBA/VC/Resume & Applications/Startups to recommend/Bulk Data/SCM_Companies_List_ocr_rows.csv')
MODEL_DIR = Path('/Users/bivekadhikari/Library/CloudStorage/GoogleDrive-bivek@berkeley.edu/My Drive/MBA/VC/Resume & Applications/Startups to recommend/Bulk Data/.easyocr-model')


def pick_largest_image(page):
    imgs = page.get_images(full=True)
    if not imgs:
        return None
    # width index=2, height index=3
    return max(imgs, key=lambda t: t[2] * t[3])[0]


def cluster_rows(items, y_tol=22):
    # items: list[(x0,y0,x1,y1,text,conf)]
    items = sorted(items, key=lambda t: (t[1], t[0]))
    rows = []
    for it in items:
        x0, y0, x1, y1, text, conf = it
        yc = (y0 + y1) / 2
        placed = False
        for row in rows:
            if abs(yc - row['yc']) <= y_tol:
                row['items'].append(it)
                row['yc'] = (row['yc'] * row['n'] + yc) / (row['n'] + 1)
                row['n'] += 1
                placed = True
                break
        if not placed:
            rows.append({'yc': yc, 'n': 1, 'items': [it]})

    out = []
    for idx, row in enumerate(sorted(rows, key=lambda r: r['yc']), start=1):
        parts = sorted(row['items'], key=lambda t: t[0])
        text_join = ' | '.join(p[4].strip() for p in parts if p[4].strip())
        out.append((idx, row['yc'], text_join, len(parts)))
    return out


def main():
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    reader = easyocr.Reader(
        ['en'],
        gpu=False,
        verbose=False,
        model_storage_directory=str(MODEL_DIR),
        user_network_directory=str(MODEL_DIR),
    )

    doc = fitz.open(str(PDF_PATH))
    raw_rows = []
    grouped_rows = []

    for pno, page in enumerate(doc, start=1):
        xref = pick_largest_image(page)
        if xref is None:
            continue
        img_data = doc.extract_image(xref)['image']
        tmp = Path(f'/tmp/scm_page_{pno}.jpg')
        tmp.write_bytes(img_data)
        img = cv2.imread(str(tmp))
        if img is None:
            continue

        det = reader.readtext(img, detail=1, paragraph=False)
        page_items = []
        for box, text, conf in det:
            xs = [pt[0] for pt in box]
            ys = [pt[1] for pt in box]
            x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
            page_items.append((x0, y0, x1, y1, text, float(conf)))
            raw_rows.append([pno, text, float(conf), x0, y0, x1, y1])

        for row_idx, y_center, row_text, token_count in cluster_rows(page_items):
            grouped_rows.append([pno, row_idx, y_center, token_count, row_text])

    with OUT_RAW.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['page', 'text', 'confidence', 'x0', 'y0', 'x1', 'y1'])
        w.writerows(raw_rows)

    with OUT_ROWS.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f)
        w.writerow(['page', 'row_index', 'y_center', 'token_count', 'row_text'])
        w.writerows(grouped_rows)

    print(f'Wrote raw OCR CSV: {OUT_RAW}')
    print(f'Wrote row-grouped CSV: {OUT_ROWS}')
    print(f'Raw entries: {len(raw_rows)}')
    print(f'Grouped rows: {len(grouped_rows)}')


if __name__ == '__main__':
    main()
