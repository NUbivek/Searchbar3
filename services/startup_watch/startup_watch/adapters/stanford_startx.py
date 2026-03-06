import requests
from bs4 import BeautifulSoup

from startup_watch.adapters.base import BaseAdapter
from startup_watch.schema import StartupSignal


class StanfordStartxAdapter(BaseAdapter):
    """Stanford StartX adapter.

    Source: StartX companies pages.
    Method: HTML parsing.
    Stage signal: cohort-backed early stage.
    Thesis alignment: industrial and supply-chain software.
    """

    source_name = "stanford_startx"

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
            for link in soup.select("a"):
                name = link.get_text(" ", strip=True)
                if not name or len(name) > 80:
                    continue
                output.append(
                    StartupSignal(
                        company_name=name,
                        stage="seed",
                        source_name=self.source_name,
                        source_url=url,
                        categories=["industrial software"],
                    ).normalize()
                )
            return output
        except Exception:
            return []
