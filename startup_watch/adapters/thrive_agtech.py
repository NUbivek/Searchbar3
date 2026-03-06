import requests
from bs4 import BeautifulSoup

from startup_watch.adapters.base import BaseAdapter
from startup_watch.schema import StartupSignal


class ThriveAgtechAdapter(BaseAdapter):
    """THRIVE AgTech cohort adapter.

    Source: THRIVE cohort pages.
    Method: HTML parsing.
    Stage signal: accelerator cohort (seed).
    Thesis alignment: agtech and food supply chain.
    """

    source_name = "thrive_agtech"

    def fetch(self) -> list[StartupSignal]:
        if not self.config.get("enabled", False):
            return []
        urls = self.config.get("urls", [])
        output: list[StartupSignal] = []
        for url in urls:
            try:
                response = requests.get(
                    url,
                    timeout=20,
                    headers={"User-Agent": "startup-watch/1.0"},
                )
                if response.status_code != 200:
                    continue
                soup = BeautifulSoup(response.text, "lxml")
                for node in soup.select("li, h2, h3, a"):
                    name = node.get_text(" ", strip=True)
                    if not name or len(name) > 80:
                        continue
                    output.append(
                        StartupSignal(
                            company_name=name,
                            stage="seed",
                            categories=["agtech", "farm tech"],
                            source_name=self.source_name,
                            source_url=url,
                        ).normalize()
                    )
            except Exception:
                continue
        return output
