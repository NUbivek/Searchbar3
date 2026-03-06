import json

import requests
from bs4 import BeautifulSoup

from startup_watch.adapters.base import BaseAdapter
from startup_watch.schema import StartupSignal


class YCombinatorAdapter(BaseAdapter):
    source_name = "yc_directory"

    def fetch(self) -> list[StartupSignal]:
        if not self.config.get("enabled", False):
            return []
        batch = self.config.get("batch", "")
        categories = set(self.config.get("categories", []))
        url = f"https://www.ycombinator.com/companies?batch={batch}"
        try:
            response = requests.get(url, timeout=20, headers={"User-Agent": "startup-watch/1.0"})
            if response.status_code != 200:
                return []
            soup = BeautifulSoup(response.text, "lxml")
            script = soup.find("script", id="__NEXT_DATA__")
            if not script or not script.string:
                return []
            data = json.loads(script.string)
            companies = data.get("props", {}).get("pageProps", {}).get("companies", [])
            out: list[StartupSignal] = []
            for company in companies:
                yc_categories = [x.get("name", "") for x in company.get("categories", [])]
                if categories and not any(c in categories for c in yc_categories):
                    continue
                out.append(
                    StartupSignal(
                        company_name=company.get("name", ""),
                        website=company.get("website", ""),
                        description=company.get("one_liner", ""),
                        stage="seed",
                        categories=yc_categories,
                        source_name=self.source_name,
                        source_url=url,
                        location=company.get("location", ""),
                        investor_names=["Y Combinator"],
                    ).normalize()
                )
            return out
        except Exception:
            return []
