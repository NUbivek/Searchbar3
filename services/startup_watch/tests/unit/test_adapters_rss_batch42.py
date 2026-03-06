from types import SimpleNamespace

from startup_watch.adapters.techbehemoths_blog import TechbehemothsBlogAdapter
from startup_watch.adapters.startupscoot import StartupscootAdapter
from startup_watch.adapters.seedrs_insights import SeedrsInsightsAdapter
from startup_watch.adapters.euvc_insights import EuvcInsightsAdapter
from startup_watch.adapters.startupmag_europe import StartupmagEuropeAdapter


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


def test_techbehemoths_blog_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techbehemoths_blog.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechbehemothsBlogAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techbehemoths_blog"

def test_startupscoot_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupscoot.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupscootAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupscoot"

def test_seedrs_insights_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.seedrs_insights.feedparser.parse", lambda _url: _fake_feed())
    adapter = SeedrsInsightsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "seedrs_insights"

def test_euvc_insights_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.euvc_insights.feedparser.parse", lambda _url: _fake_feed())
    adapter = EuvcInsightsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "euvc_insights"

def test_startupmag_europe_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupmag_europe.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupmagEuropeAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupmag_europe"
