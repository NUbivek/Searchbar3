import feedparser

from startup_watch.adapters.base import BaseAdapter
from startup_watch.schema import StartupSignal


class TechcrunchFundingAdapter(BaseAdapter):
    """TechCrunch funding RSS adapter."""

    source_name = "techcrunch_funding"

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
                title = getattr(entry, "title", "")
                link = getattr(entry, "link", "")
                summary = getattr(entry, "summary", "")
                out.append(
                    StartupSignal(
                        company_name=title[:80],
                        description=summary[:280],
                        stage="series-a",
                        categories=["supply chain", "industrial software"],
                        source_name=self.source_name,
                        source_url=link or url,
                    ).normalize()
                )
            return out
        except Exception:
            return []
