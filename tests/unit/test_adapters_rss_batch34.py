from types import SimpleNamespace

from startup_watch.adapters.pakwired import PakwiredAdapter
from startup_watch.adapters.dailysocial import DailysocialAdapter
from startup_watch.adapters.techstartups import TechstartupsAdapter
from startup_watch.adapters.startupnewsme import StartupnewsmeAdapter
from startup_watch.adapters.middleeastventures import MiddleeastventuresAdapter


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


def test_pakwired_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.pakwired.feedparser.parse", lambda _url: _fake_feed())
    adapter = PakwiredAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "pakwired"

def test_dailysocial_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.dailysocial.feedparser.parse", lambda _url: _fake_feed())
    adapter = DailysocialAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "dailysocial"

def test_techstartups_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techstartups.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechstartupsAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techstartups"

def test_startupnewsme_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupnewsme.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupnewsmeAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupnewsme"

def test_middleeastventures_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.middleeastventures.feedparser.parse", lambda _url: _fake_feed())
    adapter = MiddleeastventuresAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "middleeastventures"
