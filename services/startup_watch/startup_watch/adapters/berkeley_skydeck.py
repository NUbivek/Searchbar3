import requests
from bs4 import BeautifulSoup

from startup_watch.adapters.base import BaseAdapter
from startup_watch.schema import StartupSignal


class BerkeleySkydeckAdapter(BaseAdapter):
    """Berkeley SkyDeck adapter.

    Source: SkyDeck portfolio pages.
    Method: HTML parsing.
    Stage signal: accelerator/fund cohorts.
    Thesis alignment: supply-chain, agtech, industrial AI.
    """

    source_name = "berkeley_skydeck"

    def fetch(self) -> list[StartupSignal]:
        if not self.config.get("enabled", False):
            return []
        url = self.config.get("url", "")
        if not url:
            return []
        try:
            response = requests.get(url, timeout=20, headers={"User-Agent": "startup-watch/1.0"})
            if response.status_code != 200:
                return []
            soup = BeautifulSoup(response.text, "lxml")
            output: list[StartupSignal] = []
            for card in soup.select("h2, h3, a"):
                name = card.get_text(" ", strip=True)
                if not name or len(name) > 80:
                    continue
                output.append(
                    StartupSignal(
                        company_name=name,
                        stage="seed",
                        source_name=self.source_name,
                        source_url=url,
                        categories=["supply chain", "agtech", "industrial software"],
                    ).normalize()
                )
            return output
        except Exception:
            return []
