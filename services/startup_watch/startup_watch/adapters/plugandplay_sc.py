import requests
from bs4 import BeautifulSoup

from startup_watch.adapters.base import BaseAdapter
from startup_watch.schema import StartupSignal


class PlugandplayScAdapter(BaseAdapter):
    """Plug and Play supply chain cohort adapter.

    Source: public cohort/news pages.
    Method: HTML parsing.
    Stage signal: accelerator batch (seed).
    Thesis alignment: supply chain and logistics startups.
    """

    source_name = "plugandplay_sc"

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
            for node in soup.select("li, h2, h3, a"):
                name = node.get_text(" ", strip=True)
                if not name or len(name) > 80:
                    continue
                output.append(
                    StartupSignal(
                        company_name=name,
                        stage="seed",
                        categories=["supply chain", "logistics"],
                        source_name=self.source_name,
                        source_url=url,
                    ).normalize()
                )
            return output
        except Exception:
            return []
