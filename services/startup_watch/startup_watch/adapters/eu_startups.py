import requests
from bs4 import BeautifulSoup

from startup_watch.adapters.base import BaseAdapter
from startup_watch.schema import StartupSignal


class EuStartupsAdapter(BaseAdapter):
    """EU-Startups discovery adapter."""

    source_name = "eu_startups"

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
                        stage="pre-seed",
                        categories=["agtech", "industrial software"],
                        source_name=self.source_name,
                        source_url=url,
                    ).normalize()
                )
            return output
        except Exception:
            return []
