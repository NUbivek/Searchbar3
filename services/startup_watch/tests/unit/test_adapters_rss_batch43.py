from types import SimpleNamespace

from startup_watch.adapters.vator_startups import VatorStartupsAdapter
from startup_watch.adapters.startus_insights import StartusInsightsAdapter
from startup_watch.adapters.tracxn_blog import TracxnBlogAdapter
from startup_watch.adapters.f6s_news import F6sNewsAdapter
from startup_watch.adapters.euvc_deals import EuvcDealsAdapter


def _fake_feed() -> SimpleNamespace:
    return SimpleNamespace(
        entries=[
            SimpleNamespace(
                title="Example startup raises round",
                link="https://example.com/funding",
                summary="Company building AI software for industrial operations.",
            )
        ]
    )


def test_vator_startups_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.vator_startups.feedparser.parse", lambda _url: _fake_feed())
    adapter = VatorStartupsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "vator_startups"

def test_startus_insights_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startus_insights.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartusInsightsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startus_insights"

def test_tracxn_blog_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.tracxn_blog.feedparser.parse", lambda _url: _fake_feed())
    adapter = TracxnBlogAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "tracxn_blog"

def test_f6s_news_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.f6s_news.feedparser.parse", lambda _url: _fake_feed())
    adapter = F6sNewsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "f6s_news"

def test_euvc_deals_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.euvc_deals.feedparser.parse", lambda _url: _fake_feed())
    adapter = EuvcDealsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "euvc_deals"
