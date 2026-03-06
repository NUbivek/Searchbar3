from types import SimpleNamespace

from startup_watch.adapters.startupgenius import StartupgeniusAdapter
from startup_watch.adapters.founderjar import FounderjarAdapter
from startup_watch.adapters.smallbiztrends_startups import SmallbiztrendsStartupsAdapter
from startup_watch.adapters.startupgrind_blog import StartupgrindBlogAdapter
from startup_watch.adapters.forentrepreneurs import ForentrepreneursAdapter


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


def test_startupgenius_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupgenius.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupgeniusAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupgenius"

def test_founderjar_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.founderjar.feedparser.parse", lambda _url: _fake_feed())
    adapter = FounderjarAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "founderjar"

def test_smallbiztrends_startups_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.smallbiztrends_startups.feedparser.parse", lambda _url: _fake_feed())
    adapter = SmallbiztrendsStartupsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "smallbiztrends_startups"

def test_startupgrind_blog_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupgrind_blog.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupgrindBlogAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupgrind_blog"

def test_forentrepreneurs_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.forentrepreneurs.feedparser.parse", lambda _url: _fake_feed())
    adapter = ForentrepreneursAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "forentrepreneurs"
