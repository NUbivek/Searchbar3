import feedparser

from startup_watch.adapters.base import BaseAdapter
from startup_watch.schema import StartupSignal


class FutureAgAdapter(BaseAdapter):
    """FutureAg RSS adapter."""

    source_name = "future_ag"

    def fetch(self) -> list[StartupSignal]:
        if not self.config.get("enabled", False):
            return []
        url = self.config.get("url", "")
        if not url:
            return []
        try:
            feed = feedparser.parse(url)
            output: list[StartupSignal] = []
            for entry in feed.entries[:50]:
                title = getattr(entry, "title", "")
                link = getattr(entry, "link", "")
                summary = getattr(entry, "summary", "")
                output.append(
                    StartupSignal(
                        company_name=title[:80],
                        description=summary[:280],
                        stage="seed",
                        categories=["agtech", "farm tech"],
                        source_name=self.source_name,
                        source_url=link or url,
                    ).normalize()
                )
            return output
        except Exception:
            return []
