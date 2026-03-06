import requests
from bs4 import BeautifulSoup

from startup_watch.adapters.base import BaseAdapter
from startup_watch.schema import StartupSignal


class StartupStreamAdapter(BaseAdapter):
    source_name = "startupstream"

    def fetch(self) -> list[StartupSignal]:
        if not self.config.get("enabled", False):
            return []
        url = self.config.get("url", "https://startupstream.io")
        max_items = int(self.config.get("max_items", 200))
        try:
            response = requests.get(url, timeout=20, headers={"User-Agent": "startup-watch/1.0"})
            if response.status_code != 200:
                return []
            soup = BeautifulSoup(response.text, "lxml")
            out: list[StartupSignal] = []
            for link in soup.select("a"):
                name = link.get_text(" ", strip=True)
                href = link.get("href") or ""
                if not name or len(name) > 80:
                    continue
                out.append(
                    StartupSignal(
                        company_name=name,
                        source_name=self.source_name,
                        source_url=href,
                    )
                )
                if len(out) >= max_items:
                    break
            return out
        except Exception:
            return []
