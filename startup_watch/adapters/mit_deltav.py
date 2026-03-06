import requests
from bs4 import BeautifulSoup

from startup_watch.adapters.base import BaseAdapter
from startup_watch.schema import StartupSignal


class MitDeltavAdapter(BaseAdapter):
    """MIT Delta V adapter.

    Source: MIT Delta V cohort pages.
    Method: HTML parsing.
    Stage signal: pre-seed/seed from accelerator cohorts.
    Thesis alignment: manufacturing/supply-chain founders.
    """

    source_name = "mit_deltav"

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
                for header in soup.select("h2, h3, h4"):
                    name = header.get_text(" ", strip=True)
                    if not name or len(name) > 80:
                        continue
                    output.append(
                        StartupSignal(
                            company_name=name,
                            stage="pre-seed",
                            source_name=self.source_name,
                            source_url=url,
                            categories=["manufacturing software", "supply chain"],
                        ).normalize()
                    )
            except Exception:
                continue
        return output
