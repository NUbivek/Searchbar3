from types import SimpleNamespace

from startup_watch.adapters.frenchweb import FrenchwebAdapter
from startup_watch.adapters.maddyness_fr import MaddynessFrAdapter
from startup_watch.adapters.gruenderszene import GruenderszeneAdapter
from startup_watch.adapters.siliconallee import SiliconalleeAdapter
from startup_watch.adapters.siftedeu_news import SiftedeuNewsAdapter


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


def test_frenchweb_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.frenchweb.feedparser.parse", lambda _url: _fake_feed())
    adapter = FrenchwebAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "frenchweb"

def test_maddyness_fr_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.maddyness_fr.feedparser.parse", lambda _url: _fake_feed())
    adapter = MaddynessFrAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "maddyness_fr"

def test_gruenderszene_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.gruenderszene.feedparser.parse", lambda _url: _fake_feed())
    adapter = GruenderszeneAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "gruenderszene"

def test_siliconallee_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.siliconallee.feedparser.parse", lambda _url: _fake_feed())
    adapter = SiliconalleeAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "siliconallee"

def test_siftedeu_news_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.siftedeu_news.feedparser.parse", lambda _url: _fake_feed())
    adapter = SiftedeuNewsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "siftedeu_news"
