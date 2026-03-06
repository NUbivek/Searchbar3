import re


def infer_stage_from_text(text: str) -> str:
    normalized = text.lower()
    if "pre-seed" in normalized or "preseed" in normalized:
        return "pre-seed"
    if "series c" in normalized:
        return "series-c"
    if "series b" in normalized:
        return "series-b"
    if "series a" in normalized:
        return "series-a"
    if "seed" in normalized:
        return "seed"
    if "stealth" in normalized:
        return "stealth"
    return "unknown"


def extract_amount(text: str) -> str:
    match = re.search(r"\$\s?\d{1,3}(?:\.\d+)?\s?(?:m|million|b|billion)", text, re.I)
    return match.group(0) if match else ""
