from types import SimpleNamespace

from startup_watch.adapters.siliconrepublic_startups import SiliconrepublicStartupsAdapter
from startup_watch.adapters.techforge_media import TechforgeMediaAdapter
from startup_watch.adapters.sifted_pro import SiftedProAdapter
from startup_watch.adapters.foundersguide import FoundersguideAdapter
from startup_watch.adapters.startupvalley_news import StartupvalleyNewsAdapter


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


def test_siliconrepublic_startups_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.siliconrepublic_startups.feedparser.parse", lambda _url: _fake_feed())
    adapter = SiliconrepublicStartupsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "siliconrepublic_startups"

def test_techforge_media_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techforge_media.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechforgeMediaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techforge_media"

def test_sifted_pro_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.sifted_pro.feedparser.parse", lambda _url: _fake_feed())
    adapter = SiftedProAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "sifted_pro"

def test_foundersguide_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.foundersguide.feedparser.parse", lambda _url: _fake_feed())
    adapter = FoundersguideAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "foundersguide"

def test_startupvalley_news_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupvalley_news.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupvalleyNewsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupvalley_news"
