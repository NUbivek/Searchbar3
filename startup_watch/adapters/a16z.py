import requests
from bs4 import BeautifulSoup

from startup_watch.adapters.base import BaseAdapter
from startup_watch.schema import StartupSignal


class A16zAdapter(BaseAdapter):
    """a16z portfolio adapter.

    Source: a16z portfolio pages.
    Method: HTML parsing.
    Stage signal: portfolio-backed growth pipeline.
    Thesis alignment: industrial and logistics software.
    """

    source_name = "a16z"

    def fetch(self) -> list[StartupSignal]:
        if not self.config.get("enabled", False):
            return []
        url = self.config.get("url", "")
        if not url:
            return []
        try:
            response = requests.get(
                url,
                timeout=20,
                headers={"User-Agent": "startup-watch/1.0"},
            )
            if response.status_code != 200:
                return []
            soup = BeautifulSoup(response.text, "lxml")
            output: list[StartupSignal] = []
            for node in soup.select("a, h2, h3"):
                name = node.get_text(" ", strip=True)
                if not name or len(name) > 80:
                    continue
                output.append(
                    StartupSignal(
                        company_name=name,
                        stage="series-a",
                        categories=["industrial software", "supply chain"],
                        source_name=self.source_name,
                        source_url=url,
                    ).normalize()
                )
            return output
        except Exception:
            return []
