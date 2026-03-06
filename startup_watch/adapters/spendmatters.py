import feedparser

from startup_watch.adapters.base import BaseAdapter
from startup_watch.schema import StartupSignal


class SpendmattersAdapter(BaseAdapter):
    source_name = "spendmatters"

    def fetch(self) -> list[StartupSignal]:
        if not self.config.get("enabled", False):
            return []
        url = self.config.get("url", "")
        if not url:
            return []
        try:
            feed = feedparser.parse(url)
            out: list[StartupSignal] = []
            for entry in feed.entries[:50]:
                out.append(
                    StartupSignal(
                        company_name=getattr(entry, "title", "")[:80],
                        description=getattr(entry, "summary", "")[:280],
                        stage="seed",
                        categories=["procurement", "supply chain"],
                        source_name=self.source_name,
                        source_url=getattr(entry, "link", "") or url,
                    ).normalize()
                )
            return out
        except Exception:
            return []
