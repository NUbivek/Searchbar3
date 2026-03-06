import re

import requests
from bs4 import BeautifulSoup

from startup_watch.schema import StartupSignal


def extract_funding_amount(text: str) -> str:
    match = re.search(r"\$\s?\d{1,3}(?:\.\d+)?\s?(?:m|million|b|billion)", text, re.I)
    return match.group(0) if match else ""


def enrich_from_website(signal: StartupSignal, timeout: int = 15) -> StartupSignal:
    if not signal.website:
        return signal
    try:
        response = requests.get(
            signal.website,
            timeout=timeout,
            headers={"User-Agent": "startup-watch/1.0"},
        )
        if response.status_code != 200:
            return signal
        soup = BeautifulSoup(response.text, "lxml")
        if not signal.description and soup.title and soup.title.string:
            signal.description = soup.title.string.strip()
        if not signal.funding_amount:
            signal.funding_amount = extract_funding_amount(soup.get_text(" ", strip=True))
    except Exception:
        return signal
    return signal


def enrich_batch(signals: list[StartupSignal]) -> list[StartupSignal]:
    return [enrich_from_website(s) for s in signals]
