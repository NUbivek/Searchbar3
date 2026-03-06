from types import SimpleNamespace

from startup_watch.adapters.startupsmagazine import StartupsmagazineAdapter
from startup_watch.adapters.techpoint_africa import TechpointAfricaAdapter
from startup_watch.adapters.vccircle import VccircleAdapter


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


def test_startupsmagazine_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.startupsmagazine.feedparser.parse", lambda _url: _fake_feed())
    adapter = StartupsmagazineAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "startupsmagazine"


def test_vccircle_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.vccircle.feedparser.parse", lambda _url: _fake_feed())
    adapter = VccircleAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "vccircle"


def test_techpoint_africa_adapter_fetch(monkeypatch) -> None:
    monkeypatch.setattr("startup_watch.adapters.techpoint_africa.feedparser.parse", lambda _url: _fake_feed())
    adapter = TechpointAfricaAdapter({"enabled": True, "url": "https://example.com/feed"})

    signals = adapter.fetch()

    assert len(signals) == 1
    assert signals[0].source_name == "techpoint_africa"
